import type { GenerateContentParameters, GenerateContentResponse } from '@google/genai'

import { createApp } from '../server/app'

type Expect<T extends true> = T

type Equal<A, B> = (
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false
)

type CreateAppOptions = Parameters<typeof createApp>[0]
type AppGenerateContent = CreateAppOptions['ai']['models']['generateContent']

const requestTypeMatches: Expect<
  Equal<Parameters<AppGenerateContent>[0], GenerateContentParameters>
> = true

const responseTypeMatches: Expect<
  Equal<Awaited<ReturnType<AppGenerateContent>>, GenerateContentResponse>
> = true

void requestTypeMatches
void responseTypeMatches
