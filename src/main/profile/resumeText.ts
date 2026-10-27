import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { extractText, getDocumentProxy } from 'unpdf'
import mammoth from 'mammoth'

export class ResumeUnreadableError extends Error {
  constructor(
    message = 'This resume looks like a scanned image. Export it as a text PDF or paste your experience instead.'
  ) {
    super(message)
    this.name = 'ResumeUnreadableError'
  }
}

const MIN_CHARS = 200

export async function extractResumeText(filePath: string): Promise<string> {
  const ext = extname(filePath).toLowerCase()
  let text: string
  if (ext === '.pdf') {
    const data = new Uint8Array(await readFile(filePath))
    const pdf = await getDocumentProxy(data)
    text = (await extractText(pdf, { mergePages: true })).text
  } else if (ext === '.docx') {
    text = (await mammoth.extractRawText({ buffer: await readFile(filePath) })).value
  } else {
    throw new Error('Resume must be a PDF or DOCX file.')
  }
  if (text.replace(/\s/g, '').length < MIN_CHARS) throw new ResumeUnreadableError()
  return text
}
