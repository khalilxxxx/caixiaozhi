export interface TranslationBox {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface TranslationBlock {
  id: string;
  source: string;
  target: string;
  bbox: TranslationBox;
  confidence?: number;
}
export interface TranslationPage {
  page: number;
  width: number;
  height: number;
  imageUrl: string;
  blocks: TranslationBlock[];
}
export interface TranslationResult {
  fileId: string;
  fileName: string;
  status: 'completed';
  sourceLanguage: string;
  targetLanguage: 'zh-CN';
  pages: TranslationPage[];
  createdAt: string;
  engine?: string;
}
export const TRANSLATION_FILE_ACCEPT =
  '.png,.jpg,.jpeg,.webp,.pdf,image/png,image/jpeg,image/webp,application/pdf';
export function isTranslationFile(file: {
  name: string;
  type?: string;
}): boolean {
  const type = file.type?.toLowerCase() ?? '';
  if (type && type !== 'application/octet-stream')
    return [
      'image/png',
      'image/jpeg',
      'image/webp',
      'application/pdf',
    ].includes(type);
  return /\.(png|jpe?g|webp|pdf)$/i.test(file.name);
}
export function validateTranslationFile(file: {
  name: string;
  type?: string;
  size: number;
}): string | null {
  if (!isTranslationFile(file))
    return '请选择 PNG、JPG、WebP 图片或 PDF 文件。';
  if (!Number.isFinite(file.size) || file.size <= 0)
    return '文件为空，请重新选择。';
  if (file.size > 10 * 1024 * 1024) return '文件超过 10 MB，请压缩后重新上传。';
  return null;
}
export function normalizeTranslationBox(
  box: TranslationBox,
): TranslationBox | null {
  if (![box.x, box.y, box.width, box.height].every(Number.isFinite))
    return null;
  if (box.width <= 0 || box.height <= 0) return null;
  const x = Math.max(0, box.x),
    y = Math.max(0, box.y);
  const width = Math.min(1, box.x + box.width) - x;
  const height = Math.min(1, box.y + box.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}
export function findTranslationBlock<
  T extends { id: string; bbox: TranslationBox },
>(blocks: T[], x: number, y: number): T | undefined {
  let found: T | undefined,
    area = Infinity;
  for (const block of blocks) {
    const box = normalizeTranslationBox(block.bbox);
    if (
      box &&
      x >= box.x &&
      x <= box.x + box.width &&
      y >= box.y &&
      y <= box.y + box.height &&
      box.width * box.height < area
    ) {
      found = block;
      area = box.width * box.height;
    }
  }
  return found;
}
export function translationText(
  pages: { page: number; blocks: { target: string }[] }[],
): string {
  return pages
    .map(
      (page) =>
        `${pages.length > 1 ? `第 ${page.page} 页\n` : ''}${page.blocks.map((block) => block.target).join('\n\n')}`,
    )
    .join('\n\n');
}
