import { readFile } from 'node:fs/promises'

const readJsonIfExists = async <T>(filePath: string): Promise<T | null> => {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T
  } catch {
    return null
  }
}

const safeDecodeUri = (value: string) => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export { readJsonIfExists, safeDecodeUri }
