import { useEffect, useState } from 'react'
import { readJsonStorage, writeJsonStorage } from '../utils/storage'

export function useLocalStorageState<T>(key: string, initialValue: T) {
  const [value, setValue] = useState<T>(() => readJsonStorage<T>(key, initialValue))
  useEffect(() => {
    writeJsonStorage(key, value)
  }, [key, value])
  return [value, setValue] as const
}
