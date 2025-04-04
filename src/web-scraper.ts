import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Browser, Page } from 'puppeteer';
import axios from 'axios';
import { compact } from 'lodash-es';
import pLimit from 'p-limit';
import { JSDOM } from 'jsdom';
import TurndownService from 'turndown';
import chalk from 'chalk';

// Initialize turndown for HTML to Markdown conversion
const turndown = new TurndownService();

// Add stealth plugin to puppeteer
puppeteer.use(StealthPlugin());

// Types to maintain compatibility with original Firecrawl implementation
export interface SearchItem {
  url: string;
  title: string;
  snippet?: string;
  markdown?: string;
  html?: string;
}

export interface SearchResponse {
  query: string;
  data: SearchItem[];
  timing: {
    total: number;
    search: number;
    content: number;
    details: Record<string, number>;
  };
}

// Configuration
const SERPER_API_KEY = process.env.SERPER_API_KEY || '';
const SERPER_ENGINE = process.env.SERPER_ENGINE || 'google'; // 'google', 'bing', 'baidu', etc.
const PUPPETEER_CONCURRENCY = Number(process.env.PUPPETEER_CONCURRENCY) || 2;
const MAX_RESULTS = 5; // Number of search results to process

// Logger avec niveaux et couleurs
function log(level: string, message: string, ...args: any[]) {
  const timestamp = new Date().toISOString();
  let coloredLevel: string;
  
  switch(level) {
    case 'INFO':
      coloredLevel = chalk.green(`[${level}]`);
      break;
    case 'WARN':
      coloredLevel = chalk.yellow(`[${level}]`);
      break;
    case 'ERROR':
      coloredLevel = chalk.red(`[${level}]`);
      break;
    case 'DEBUG':
      coloredLevel = chalk.blue(`[${level}]`);
      break;
    case 'SUCCESS':
      coloredLevel = chalk.green.bold(`[${level}]`);
      break;
    default:
      coloredLevel = `[${level}]`;
  }
  
  console.log(`[${timestamp}] ${coloredLevel} ${message}`, ...args);
}

// Fonction utilitaire pour formater la durée
function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) {
    return `${milliseconds}ms`;
  } else if (milliseconds < 60000) {
    return `${(milliseconds / 1000).toFixed(2)}s`;
  } else {
    const minutes = Math.floor(milliseconds / 60000);
    const seconds = ((milliseconds % 60000) / 1000).toFixed(1);
    return `${minutes}m ${seconds}s`;
  }
}

export class WebScraperApp {
  private browser: Browser | null = null;
  private concurrencyLimit = pLimit(PUPPETEER_CONCURRENCY);
  private timings: Record<string, number> = {};

  constructor() {
    // Initialize browser lazily when needed
    log('INFO', `WebScraper initialisé avec concurrence: ${PUPPETEER_CONCURRENCY}`);
  }

  private async getBrowser(): Promise<Browser> {
    const startTime = Date.now();
    if (!this.browser) {
      log('INFO', 'Lancement du navigateur Puppeteer...');
      this.browser = await puppeteer.launch({
        headless: 'new',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
          '--window-size=1920x1080',
        ],
      });
      const duration = Date.now() - startTime;
      log('SUCCESS', `Navigateur lancé avec succès en ${formatDuration(duration)}`);
      this.timings['browser_launch'] = duration;
    }
    return this.browser;
  }

  public async close() {
    const startTime = Date.now();
    if (this.browser) {
      log('INFO', 'Fermeture du navigateur Puppeteer...');
      await this.browser.close();
      this.browser = null;
      const duration = Date.now() - startTime;
      log('SUCCESS', `Navigateur fermé avec succès en ${formatDuration(duration)}`);
      this.timings['browser_close'] = duration;
    }
  }

  /**
   * Perform a search and return the results
   */
  public async search(query: string, options: { timeout?: number; limit?: number } = {}): Promise<SearchResponse> {
    const globalStartTime = Date.now();
    const timeout = options.timeout || 15000;
    const limit = options.limit || MAX_RESULTS;
    this.timings = {}; // Reset timings for this search
    
    log('INFO', `====== DÉMARRAGE DE LA RECHERCHE: "${query}" ======`);
    log('INFO', `Options de recherche: timeout=${timeout}ms, limite=${limit} résultats`);
    
    try {
      // Get search results via Serper.dev API
      const searchStartTime = Date.now();
      log('INFO', `Récupération des résultats de recherche pour "${query}" via Serper.dev...`);
      const searchResults = await this.getSerperSearchResults(query, limit);
      const searchEndTime = Date.now();
      const searchDuration = searchEndTime - searchStartTime;
      this.timings['search_api'] = searchDuration;
      
      log('SUCCESS', `Trouvé ${searchResults.length} résultats en ${formatDuration(searchDuration)}`);
      
      if (searchResults.length === 0) {
        log('WARN', `Aucun résultat trouvé pour "${query}"`);
        return { 
          query, 
          data: [],
          timing: {
            total: Date.now() - globalStartTime,
            search: searchDuration,
            content: 0,
            details: this.timings
          }
        };
      }
      
      // Process each search result to get content with Puppeteer
      const contentStartTime = Date.now();
      log('INFO', `Récupération du contenu pour ${searchResults.length} URLs avec Puppeteer (concurrence: ${PUPPETEER_CONCURRENCY})...`);
      
      const contentPromises = searchResults.map((result, index) => 
        this.concurrencyLimit(async () => {
          const urlStartTime = Date.now();
          log('INFO', `[${index + 1}/${searchResults.length}] Traitement de: ${result.url}`);
          
          const content = await this.fetchContentViaPuppeteer(result.url, timeout);
          
          const urlDuration = Date.now() - urlStartTime;
          this.timings[`url_${index + 1}`] = urlDuration;
          
          log('SUCCESS', `[${index + 1}/${searchResults.length}] ${result.url} traité en ${formatDuration(urlDuration)}`);
          return content;
        })
      );
      
      const contents = await Promise.all(contentPromises);
      const contentEndTime = Date.now();
      const contentDuration = contentEndTime - contentStartTime;
      this.timings['content_fetch_total'] = contentDuration;
      
      // Count successful content retrievals
      const successfulContents = contents.filter(content => content.markdown || content.html).length;
      log('SUCCESS', `Contenu récupéré avec succès pour ${successfulContents}/${searchResults.length} URLs en ${formatDuration(contentDuration)}`);
      
      // Merge search results with content
      const data = searchResults.map((result, index) => ({
        ...result,
        ...contents[index]
      }));
      
      const totalDuration = Date.now() - globalStartTime;
      log('SUCCESS', `====== RECHERCHE TERMINÉE: "${query}" en ${formatDuration(totalDuration)} ======`);
      
      // Afficher un résumé des temps
      log('INFO', `[RÉSUMÉ TEMPS] Recherche API: ${formatDuration(searchDuration)} | Récupération contenu: ${formatDuration(contentDuration)} | Total: ${formatDuration(totalDuration)}`);
      
      return {
        query,
        data: compact(data), // Remove any null or undefined items
        timing: {
          total: totalDuration,
          search: searchDuration,
          content: contentDuration,
          details: this.timings
        }
      };
    } catch (error) {
      const totalDuration = Date.now() - globalStartTime;
      log('ERROR', `Erreur lors de la recherche pour "${query}":`, error);
      log('INFO', `Recherche échouée après ${formatDuration(totalDuration)}`);
      
      return { 
        query, 
        data: [],
        timing: {
          total: totalDuration,
          search: this.timings['search_api'] || 0,
          content: this.timings['content_fetch_total'] || 0,
          details: this.timings
        }
      };
    }
  }

  /**
   * Get search results via Serper.dev API
   */
  private async getSerperSearchResults(query: string, limit: number): Promise<SearchItem[]> {
    const startTime = Date.now();
    try {
      if (!SERPER_API_KEY) {
        log('ERROR', '❌ Clé API Serper.dev non fournie. Elle est requise pour les recherches');
        return [];
      }

      log('INFO', `🌐 OUTIL: Utilisation de Serper.dev pour obtenir les résultats de recherche pour "${query}"`);
      
      // Prepare the request payload
      const data = JSON.stringify({
        q: query,
        num: limit, // Request the number of results we need
        gl: "fr", // Set to France for French results
        hl: "fr", // Set language to French
      });

      // Configure the request options
      const config = {
        method: 'post',
        url: `https://${SERPER_ENGINE}.serper.dev/search`,
        headers: {
          'X-API-KEY': SERPER_API_KEY,
          'Content-Type': 'application/json'
        },
        data: data,
        timeout: 30000 // 30 second timeout
      };

      // Make the API request
      log('INFO', `Envoi de la requête à l'API Serper.dev...`);
      const requestStartTime = Date.now();
      const response = await axios.request(config);
      const requestDuration = Date.now() - requestStartTime;
      this.timings['serper_api_request'] = requestDuration;

      log('SUCCESS', `Réponse de Serper.dev reçue en ${formatDuration(requestDuration)}: status=${response.status}`);
      
      if (!response.data) {
        log('ERROR', '❌ Réponse vide de Serper.dev');
        return [];
      }
      
      // Extract organic search results
      const organicResults = response.data.organic || [];
      log('INFO', `Trouvé ${organicResults.length} résultats de recherche organiques`);
      
      // Map results to our SearchItem interface
      const results: SearchItem[] = organicResults.map((result: any) => ({
        url: result.link,
        title: result.title || '',
        snippet: result.snippet || ''
      })).slice(0, limit);

      const totalDuration = Date.now() - startTime;
      this.timings['serper_processing'] = totalDuration - requestDuration;
      
      log('SUCCESS', `✅ Extraction réussie de ${results.length} résultats de recherche en ${formatDuration(totalDuration)}`);
      return results;
    } catch (error) {
      const totalDuration = Date.now() - startTime;
      log('ERROR', `❌ ERREUR lors de l'utilisation de l'API Serper.dev (${formatDuration(totalDuration)}):`, error);
      return [];
    }
  }

  /**
   * Fetch content via Puppeteer
   */
  private async fetchContentViaPuppeteer(url: string, timeout: number): Promise<{ markdown?: string; html?: string }> {
    let page: Page | null = null;
    const startTime = Date.now();
    let timings: Record<string, number> = {};
    
    try {
      log('INFO', `🤖 OUTIL: Utilisation de Puppeteer pour récupérer le contenu de "${url}"`);
      
      const browserStartTime = Date.now();
      const browser = await this.getBrowser();
      timings['browser_get'] = Date.now() - browserStartTime;
      
      const pageStartTime = Date.now();
      page = await browser.newPage();
      timings['page_creation'] = Date.now() - pageStartTime;

      // Set user agent and viewport
      const setupStartTime = Date.now();
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');
      await page.setViewport({ width: 1366, height: 768 });
      await page.setDefaultNavigationTimeout(timeout);
      timings['page_setup'] = Date.now() - setupStartTime;
      
      // Block unnecessary resources to speed up loading
      const interceptStartTime = Date.now();
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const resourceType = req.resourceType();
        if (resourceType === 'image' || resourceType === 'media' || resourceType === 'font' || 
            resourceType === 'websocket') {
          req.abort();
        } else {
          req.continue();
        }
      });
      timings['intercept_setup'] = Date.now() - interceptStartTime;

      log('INFO', `Navigation vers: ${url} avec Puppeteer (timeout: ${timeout}ms)`);
      
      // Navigate to URL with more forgiving timeout and options
      const navigationStartTime = Date.now();
      try {
        await page.goto(url, { 
          waitUntil: 'domcontentloaded', 
          timeout 
        });
        
        // Wait a bit more for dynamic content
        await page.waitForTimeout(2000);
        
        timings['navigation'] = Date.now() - navigationStartTime;
        log('SUCCESS', `✅ Page chargée avec succès en ${formatDuration(timings['navigation'])}`);
      } catch (navError) {
        timings['navigation_error'] = Date.now() - navigationStartTime;
        log('WARN', `⚠️ Problème de navigation: ${navError.message} (après ${formatDuration(timings['navigation_error'])})`);
        // Even if timeout or other navigation error, try to extract content anyway
      }

      // Handle potential cookie prompts or overlays
      const obstaclesStartTime = Date.now();
      await this.handleCommonObstacles(page);
      timings['obstacles_handling'] = Date.now() - obstaclesStartTime;

      // Extract content
      const contentExtractionStartTime = Date.now();
      const html = await page.content();
      log('INFO', `Extrait ${html.length} octets de HTML brut`);
      
      // Get main content
      log('INFO', `Extraction du contenu principal de la page...`);
      const mainContent = await this.extractMainContent(page, html);
      timings['content_extraction'] = Date.now() - contentExtractionStartTime;
      log('INFO', `Extrait ${mainContent.length} octets de contenu filtré en ${formatDuration(timings['content_extraction'])}`);
      
      // Convert to markdown
      const markdownStartTime = Date.now();
      const markdown = this.cleanAndConvertToMarkdown(mainContent);
      timings['markdown_conversion'] = Date.now() - markdownStartTime;
      log('SUCCESS', `✅ Conversion HTML en ${markdown?.length || 0} octets de markdown en ${formatDuration(timings['markdown_conversion'])}`);
      
      // Add detailed timings to global timings
      Object.entries(timings).forEach(([key, value]) => {
        this.timings[`${url.substring(0, 20)}_${key}`] = value;
      });
      
      const totalDuration = Date.now() - startTime;
      log('INFO', `URL traitée en ${formatDuration(totalDuration)}: ${url}`);
      
      return { html: mainContent, markdown };
    } catch (error) {
      const totalDuration = Date.now() - startTime;
      log('ERROR', `❌ ERREUR lors de l'utilisation de Puppeteer pour ${url} (${formatDuration(totalDuration)}):`, error);
      return {};
    } finally {
      if (page) {
        const closeStartTime = Date.now();
        await page.close().catch(() => {});
        const closeDuration = Date.now() - closeStartTime;
        log('DEBUG', `Page fermée en ${formatDuration(closeDuration)}`);
      }
    }
  }

  /**
   * Handle common obstacles like cookie banners and popups
   */
  private async handleCommonObstacles(page: Page): Promise<void> {
    const startTime = Date.now();
    try {
      log('DEBUG', 'Tentative de gestion des obstacles (cookies, popups)...');
      
      // Array of common cookie consent and popup selectors
      const commonSelectors = [
        // Cookie consent buttons
        '#accept-cookies', '.accept-cookies', '.cookie-accept', '.accept-all',
        'button[contains(text(), "Accept")]', 'button[contains(text(), "Accept All")]',
        'button[contains(text(), "I agree")]', 'button[contains(text(), "Accept Cookies")]',
        // Common class names for cookie banners
        '.cookie-banner button', '.cookie-dialog button', '.consent-banner button',
        // Common popup close buttons
        '.modal-close', '.popup-close', '.close-button', '.dismiss', 
        // Specific common implementations
        '#onetrust-accept-btn-handler', '.cc-dismiss', '.gdpr-consent-button',
        // French specific selectors
        'button[contains(text(), "Accepter")]', 'button[contains(text(), "J\'accepte")]',
        'button[contains(text(), "Tout accepter")]', '.agree-button', '.consent-accept'
      ];
      
      let obstaclesFound = 0;
      
      // Try each selector
      for (const selector of commonSelectors) {
        const elements = await page.$$(selector);
        if (elements.length > 0) {
          log('DEBUG', `Obstacle trouvé avec le sélecteur: ${selector}`);
          await elements[0].click().catch(() => {});
          await page.waitForTimeout(500);
          obstaclesFound++;
        }
      }
      
      // Try to click anything that looks like "Accept" or "Close" buttons
      const buttonResult = await page.$$eval('button, .button, [role="button"]', buttons => {
        const acceptTextRegex = /accept|agree|consent|gotit|close|dismiss|ok|continue|accepter|j'accepte|fermer/i;
        let clicked = 0;
        
        for (const button of buttons) {
          const buttonText = button.textContent || '';
          if (acceptTextRegex.test(buttonText)) {
            try {
              (button as HTMLElement).click();
              clicked++;
            } catch (e) {}
          }
        }
        
        return clicked;
      });
      
      obstaclesFound += buttonResult;
      
      const duration = Date.now() - startTime;
      if (obstaclesFound > 0) {
        log('DEBUG', `Gestion des obstacles terminée: ${obstaclesFound} obstacles traités en ${formatDuration(duration)}`);
      } else {
        log('DEBUG', `Aucun obstacle détecté (vérification en ${formatDuration(duration)})`);
      }
    } catch (error) {
      const duration = Date.now() - startTime;
      log('WARN', `Erreur lors de la gestion des obstacles (${formatDuration(duration)}): ${error.message}`);
      // Continue anyway
    }
  }

  /**
   * Extract main content from page
   */
  private async extractMainContent(page: Page, fullHtml: string): Promise<string> {
    const startTime = Date.now();
    try {
      log('DEBUG', 'Identification et extraction du contenu principal...');
      
      // Try to identify and extract the main content
      const mainContent = await page.evaluate(() => {
        // Common selectors for main content, prioritized
        const selectors = [
          'article', 'main', '.article', '.post', '.entry',
          '.main-content', '#article', '#content', '.content',
          '.post-content', '.entry-content', '#main',
          '[role="main"]', '.page-content', '.article-content',
          // Fallbacks
          '#primary', '.primary', '.container', '.wrapper'
        ];

        // Try each selector
        for (const selector of selectors) {
          const element = document.querySelector(selector);
          if (element && element.textContent && element.textContent.length > 300) {
            // Check if this element contains a good proportion of the text
            const elementTextRatio = element.textContent.length / 
                (document.body?.textContent?.length || element.textContent.length);
            
            // If the element has a significant portion of the page's text (>30%)
            if (elementTextRatio > 0.3) {
              return { 
                html: element.outerHTML,
                selector: selector,
                textLength: element.textContent.length,
                ratio: elementTextRatio
              };
            }
          }
        }

        // If no good element found, try to get the body minus problematic elements
        const body = document.body;
        if (body) {
          // Remove headers, footers, sidebars, navigation, etc.
          const elementsToRemove = [
            'header', 'footer', 'nav', '.sidebar', '.nav', '.navigation',
            '.menu', '.ad', '.ads', '.advertisement', '.banner', 
            '.cookie', '.popup', '.modal', '.comments', '.related',
            '#header', '#footer', '#sidebar', '#nav', '#menu',
            '[role="banner"]', '[role="navigation"]', '[role="complementary"]'
          ];
          
          // Create a clone to avoid modifying the actual page
          const clone = body.cloneNode(true) as HTMLBodyElement;
          
          // Remove unwanted elements from clone
          let removed = 0;
          elementsToRemove.forEach(selector => {
            const elements = clone.querySelectorAll(selector);
            elements.forEach(el => {
              el.parentNode?.removeChild(el);
              removed++;
            });
          });
          
          return { 
            html: clone.outerHTML,
            selector: 'body-cleaned',
            textLength: clone.textContent?.length || 0,
            removedElements: removed
          };
        }

        // Last resort: return entire body
        return { 
          html: document.body.outerHTML,
          selector: 'body-full',
          textLength: document.body.textContent?.length || 0
        };
      });

      const duration = Date.now() - startTime;
      
      if (mainContent && typeof mainContent === 'object') {
        log('DEBUG', `Contenu principal extrait en ${formatDuration(duration)} via sélecteur "${mainContent.selector}" (longueur: ${mainContent.textLength} caractères${mainContent.ratio ? `, ratio: ${(mainContent.ratio * 100).toFixed(1)}%` : ''})`);
        return mainContent.html;
      } else {
        log('WARN', `Extraction de contenu principal échouée, utilisation du HTML complet (${formatDuration(duration)})`);
        return fullHtml;
      }
    } catch (error) {
      const duration = Date.now() - startTime;
      log('ERROR', `Erreur lors de l'extraction du contenu principal (${formatDuration(duration)}):`, error);
      return fullHtml;
    }
  }

  /**
   * Clean HTML and convert to markdown
   */
  private cleanAndConvertToMarkdown(html: string): string {
    const startTime = Date.now();
    try {
      log('DEBUG', `Nettoyage du HTML et conversion en markdown (${html.length} octets)...`);
      
      // Parse HTML
      const cleanHtmlWithoutCss = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
      const dom = new JSDOM(cleanHtmlWithoutCss);
      const document = dom.window.document;

      // Remove scripts, styles, and other non-content elements
      const elementsToRemove = [
        'script', 'style', 'iframe', 'noscript',
        'svg', 'form', 'input', 'button',
        '.ad', '.ads', '.advertisement', '.cookie-notice',
        '.sidebar', '.comment', '.comments', '.related-posts',
        '.social-share', '.share-buttons', '.newsletter',
        '.author-bio', '.author-box', '.widget'
      ];

      let elementsRemoved = 0;
      elementsToRemove.forEach(selector => {
        const elements = document.querySelectorAll(selector);
        elements.forEach(el => {
          el.parentNode?.removeChild(el);
          elementsRemoved++;
        });
      });

      // Convert to markdown
      const cleanHtml = document.body.innerHTML;
      const markdown = turndown.turndown(cleanHtml);

      // Clean up markdown
      const cleanedMarkdown = markdown
        .replace(/\n{3,}/g, '\n\n') // Remove excessive newlines
        .replace(/!\[.*?\]\(.*?\)/g, '') // Remove images
        .replace(/\[(.*?)\]\((https?:\/\/.*?)\)/g, '$1 ($2)') // Convert links to text with URL
        .replace(/(\d+)\. /g, '$1\\. ') // Escape numbered lists
        .replace(/^- /gm, '* ') // Standardize bullet lists
        .trim();

      const duration = Date.now() - startTime;
      log('DEBUG', `Conversion HTML->Markdown terminée en ${formatDuration(duration)}: ${elementsRemoved} éléments supprimés, ${cleanedMarkdown.length} octets générés`);
      
      return cleanedMarkdown;
    } catch (error) {
      const duration = Date.now() - startTime;
      log('ERROR', `Erreur lors de la conversion HTML vers markdown (${formatDuration(duration)}):`, error);
      return '';
    }
  }
}

// Export a default instance for easy use
const webScraper = new WebScraperApp();
export default webScraper;