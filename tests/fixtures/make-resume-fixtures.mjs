// Dev-only: regenerates resume.pdf, resume.docx and scanned.pdf. Run: node tests/fixtures/make-resume-fixtures.mjs
// The binaries are committed; tests never run this. The person below is invented.
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx'

const dir = dirname(fileURLToPath(import.meta.url))

const LINES = [
  'Priya Raman',
  'priya.raman@example.com | Pune, India | github.com/priyaraman-demo',
  'Summary',
  'Full-stack engineer with 4 years of experience building data-heavy web products for small teams.',
  'I enjoy shipping quickly, owning features end to end, and talking directly to users.',
  'Experience',
  'Software Engineer, Lumen Analytics (Jan 2023 - Present)',
  'Built a React and Node dashboard that cut report generation time from 40 seconds to 6 seconds.',
  'Designed a Postgres schema and background job system that processes 2 million events per day.',
  'Mentored two junior engineers and introduced code review guidelines across the team.',
  'Junior Developer, Brightpath Labs (Jul 2021 - Dec 2022)',
  'Developed internal tools in TypeScript and Python that saved the support team 15 hours a week.',
  'Wrote integration tests that raised coverage from 30 percent to 78 percent.',
  'Led the migration of a legacy monolith to modular services, reducing deploy time from 45 minutes to 8 minutes.',
  'Partnered with designers and customer success to prioritise a roadmap driven by interviews with twenty customers.',
  'Built a CSV import pipeline in Python that validates, deduplicates and loads files of up to 500,000 rows.',
  'Maintained uptime above 99.9 percent for two years through alerting, runbooks and careful incident reviews.',
  'Open source contributor to several TypeScript libraries, including fixes to date handling and parsing bugs.',
  'Speaker at a local meetup on offline-first design and conflict resolution in small mobile applications.',
  'Projects',
  'TrailNotes: an offline-first hiking journal app with 1,200 monthly active users.',
  'QuickInvoice: an open source invoicing tool with 340 GitHub stars and 25 contributors.',
  'Skills',
  'TypeScript, React, Node.js, Python, PostgreSQL, Docker, AWS, REST APIs, testing, product thinking.',
  'Education',
  'B.Tech in Computer Science, Savitribai Phule Pune University, 2021.'
]

function crc32(buf) {
  let c,
    crc = 0xffffffff
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = (crc >>> 8) ^ c
  }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
function png(w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0
    for (let x = 0; x < w * 3; x++) raw[y * (w * 3 + 1) + 1 + x] = (x * 7 + y * 13) & 0xff
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const pdf = await PDFDocument.create()
const font = await pdf.embedFont(StandardFonts.Helvetica)
const page = pdf.addPage([595, 842])
let y = 800
for (const line of LINES) {
  page.drawText(line, { x: 40, y, size: 10, font })
  y -= 18
}
writeFileSync(join(dir, 'resume.pdf'), await pdf.save())

const scanned = await PDFDocument.create()
const sp = scanned.addPage([595, 842])
const img = await scanned.embedPng(png(128, 128))
sp.drawImage(img, { x: 40, y: 300, width: 500, height: 500 })
writeFileSync(join(dir, 'scanned.pdf'), await scanned.save())

const doc = new Document({
  sections: [
    {
      children: LINES.map((l, i) =>
        i === 0
          ? new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(l)] })
          : ['Summary', 'Experience', 'Projects', 'Skills', 'Education'].includes(l)
            ? new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(l)] })
            : new Paragraph({ children: [new TextRun(l)] })
      )
    }
  ]
})
writeFileSync(join(dir, 'resume.docx'), await Packer.toBuffer(doc))
