import { createOpenAI } from '@ai-sdk/openai';
import {
  extractReasoningMiddleware,
  LanguageModelV1,
  wrapLanguageModel,
} from 'ai';
import { getEncoding } from 'js-tiktoken';

import { RecursiveCharacterTextSplitter } from './text-splitter';

// Providers
const openai = process.env.OPENAI_KEY
  ? createOpenAI({
      apiKey: process.env.OPENAI_KEY,
      baseURL: process.env.OPENAI_ENDPOINT || 'https://api.openai.com/v1',
    })
  : undefined;

// DeepSeek provider using OpenAI compatible API
const deepseek = process.env.DEEPSEEK_KEY
  ? createOpenAI({
      apiKey: process.env.DEEPSEEK_KEY,
      baseURL: process.env.DEEPSEEK_ENDPOINT || 'https://api.deepseek.com/v1',
    })
  : undefined;

const customModel = process.env.CUSTOM_MODEL && openai
  ? openai(process.env.CUSTOM_MODEL, {
      structuredOutputs: true,
    })
  : undefined;

// Create configurable OpenAI model based on env variables
const openaiModel = openai && process.env.OPENAI_MODEL
  ? wrapLanguageModel({
      model: openai(
        process.env.OPENAI_MODEL,
        {
          reasoningEffort: process.env.OPENAI_REASONING_EFFORT || 'medium',
          structuredOutputs: true,
        }
      ) as LanguageModelV1,
      middleware: extractReasoningMiddleware({ tagName: 'think' }),
    })
  : undefined;

// Fallback to o3-mini if no OPENAI_MODEL is specified
const o3MiniModel = openai && !process.env.OPENAI_MODEL
  ? openai('o3-mini', {
      reasoningEffort: 'medium',
      structuredOutputs: true,
    })
  : undefined;

// DeepSeek models with configurable model selection
const deepSeekModel = deepseek 
  ? wrapLanguageModel({
      model: deepseek(
        process.env.DEEPSEEK_MODEL || 'deepseek-v3',
      ) as LanguageModelV1,
      middleware: extractReasoningMiddleware({ tagName: 'think' }),
    })
  : undefined;

export function getModel(): LanguageModelV1 {
  // First check for a custom model specified in .env
  if (customModel) {
    return customModel;
  }
  
  // Check for a model specified by MODEL_PROVIDER env var
  const modelProvider = process.env.MODEL_PROVIDER?.toLowerCase() || '';
  
  if (modelProvider === 'deepseek' && deepSeekModel) {
    return deepSeekModel;
  }
  
  if (modelProvider === 'openai') {
    // Use the specified OpenAI model or fallback to o3-mini
    const selectedOpenAIModel = openaiModel || o3MiniModel;
    if (selectedOpenAIModel) {
      return selectedOpenAIModel;
    }
  }
  
  // Default model selection logic (try each provider in order)
  const model = openaiModel || o3MiniModel || deepSeekModel;
  if (!model) {
    throw new Error('No model found. Please configure at least one provider in your .env file.');
  }

  return model as LanguageModelV1;
}

const MinChunkSize = 140;
const encoder = getEncoding('o200k_base');

// trim prompt to maximum context size
export function trimPrompt(
  prompt: string,
  contextSize = Number(process.env.CONTEXT_SIZE) || 128_000,
) {
  if (!prompt) {
    return '';
  }

  const length = encoder.encode(prompt).length;
  if (length <= contextSize) {
    return prompt;
  }

  const overflowTokens = length - contextSize;
  // on average it's 3 characters per token, so multiply by 3 to get a rough estimate of the number of characters
  const chunkSize = prompt.length - overflowTokens * 3;
  if (chunkSize < MinChunkSize) {
    return prompt.slice(0, MinChunkSize);
  }

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize,
    chunkOverlap: 0,
  });
  const trimmedPrompt = splitter.splitText(prompt)[0] ?? '';

  // last catch, there's a chance that the trimmed prompt is same length as the original prompt, due to how tokens are split & innerworkings of the splitter, handle this case by just doing a hard cut
  if (trimmedPrompt.length === prompt.length) {
    return trimPrompt(prompt.slice(0, chunkSize), contextSize);
  }

  // recursively trim until the prompt is within the context size
  return trimPrompt(trimmedPrompt, contextSize);
}