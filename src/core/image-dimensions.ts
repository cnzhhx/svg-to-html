import { readFile } from 'node:fs/promises'

type ImageDimensions = {
  height: number
  width: number
}

const readPngDimensions = (buffer: Buffer): ImageDimensions | null => {
  const isPng =
    buffer.length >= 24 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  if (!isPng) return null
  return {
    height: buffer.readUInt32BE(20),
    width: buffer.readUInt32BE(16),
  }
}

const readGifDimensions = (buffer: Buffer): ImageDimensions | null => {
  const signature = buffer.subarray(0, 6).toString('ascii')
  if (signature !== 'GIF87a' && signature !== 'GIF89a') return null
  if (buffer.length < 10) return null
  return {
    height: buffer.readUInt16LE(8),
    width: buffer.readUInt16LE(6),
  }
}

const readWebpDimensions = (buffer: Buffer): ImageDimensions | null => {
  if (
    buffer.length < 30 ||
    buffer.subarray(0, 4).toString('ascii') !== 'RIFF' ||
    buffer.subarray(8, 12).toString('ascii') !== 'WEBP'
  ) {
    return null
  }

  const chunkType = buffer.subarray(12, 16).toString('ascii')
  if (chunkType === 'VP8X' && buffer.length >= 30) {
    return {
      height: 1 + buffer.readUIntLE(27, 3),
      width: 1 + buffer.readUIntLE(24, 3),
    }
  }

  if (chunkType === 'VP8 ' && buffer.length >= 30) {
    return {
      height: buffer.readUInt16LE(28) & 0x3fff,
      width: buffer.readUInt16LE(26) & 0x3fff,
    }
  }

  if (chunkType === 'VP8L' && buffer.length >= 25) {
    const bits = buffer.readUInt32LE(21)
    return {
      height: 1 + ((bits >> 14) & 0x3fff),
      width: 1 + (bits & 0x3fff),
    }
  }

  return null
}

const readJpegDimensions = (buffer: Buffer): ImageDimensions | null => {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null

  let offset = 2
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1
      continue
    }

    const marker = buffer[offset + 1] ?? 0
    offset += 2

    if (marker === 0xd8 || marker === 0xd9) continue
    if (marker >= 0xd0 && marker <= 0xd7) continue
    if (offset + 2 > buffer.length) return null

    const length = buffer.readUInt16BE(offset)
    if (length < 2 || offset + length > buffer.length) return null

    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    if (isStartOfFrame && length >= 7) {
      return {
        height: buffer.readUInt16BE(offset + 3),
        width: buffer.readUInt16BE(offset + 5),
      }
    }

    offset += length
  }

  return null
}

const readImageDimensions = async (
  imagePath: string,
): Promise<ImageDimensions | null> => {
  const buffer = await readFile(imagePath)
  return (
    readPngDimensions(buffer) ??
    readJpegDimensions(buffer) ??
    readWebpDimensions(buffer) ??
    readGifDimensions(buffer)
  )
}

export type { ImageDimensions }
export { readImageDimensions }
