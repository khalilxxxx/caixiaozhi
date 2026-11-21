async function createReceiptPdf({ orderNumber, amount }) {
  const pageWidth = 841.89;
  const pageHeight = 595.28;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(pageWidth * 2);
  canvas.height = Math.round(pageHeight * 2);

  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('浏览器无法生成回单 PDF。');
  context.scale(canvas.width / pageWidth, canvas.height / pageHeight);

  const ink = '#172b36';
  const muted = '#586b74';
  const border = '#d8e2e4';
  const teal = '#21645b';
  const sampleInk = '#8c3e2e';
  const fontFamily =
    '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
  const textRuns = [];

  function rect(color, x, y, width, height) {
    context.fillStyle = color;
    context.fillRect(x, y, width, height);
  }

  function drawText(
    value,
    x,
    y,
    { size = 13, color = ink, weight = 400, maxWidth = Infinity } = {},
  ) {
    context.font = `${weight} ${size}px ${fontFamily}`;
    const naturalWidth = context.measureText(value).width;
    const fittedSize = Math.min(size, size * (maxWidth / naturalWidth));
    context.font = `${weight} ${fittedSize}px ${fontFamily}`;
    context.fillStyle = color;
    const width = Math.min(context.measureText(value).width, maxWidth);
    context.fillText(value, x, y, width);
    textRuns.push({ value, x, y, size: fittedSize, width });
  }

  const left = 44;
  const right = pageWidth - left;
  const contentWidth = right - left;
  const midpoint = pageWidth / 2;
  rect('#ffffff', 0, 0, pageWidth, pageHeight);
  rect(teal, 0, 0, pageWidth, 6);
  rect(teal, left, 36, 3, 16);
  drawText('财小智', left + 11, 50, { size: 15, weight: 700 });
  drawText('资金管理', left + 70, 50, { size: 11, color: muted });
  rect('#faece6', right - 62, 31, 62, 26);
  drawText('样本', right - 44, 50, { color: sampleInk, weight: 600 });

  drawText('银行电子回单', left, 110, { size: 32, weight: 700 });
  rect(border, left, 135, contentWidth, 1);

  const amountColumn = left + 478;
  rect('#edf5f3', left, 163, contentWidth, 110);
  rect('#d2e2df', amountColumn, 182, 1, 72);
  drawText('业务单号', left + 22, 197, { color: muted, weight: 500 });
  drawText('交易金额（人民币）', amountColumn + 22, 197, {
    color: muted,
    weight: 500,
  });
  drawText(orderNumber, left + 22, 241, {
    size: 22,
    weight: 600,
    maxWidth: amountColumn - left - 44,
  });
  drawText(`¥ ${amount}`, amountColumn + 22, 241, {
    size: 34,
    color: teal,
    weight: 700,
    maxWidth: right - amountColumn - 44,
  });

  const details = [
    ['付款户名', '示例付款企业', '收款户名', '示例收款企业'],
    ['付款账号', '**** **** **** 1024', '收款账号', '**** **** **** 2048'],
    ['业务摘要', '企业转账', '数据来源', '财小智演示数据'],
  ];
  rect(border, left, 305, contentWidth, 1);
  rect(border, midpoint, 305, 1, 174);
  details.forEach(([leftLabel, leftValue, rightLabel, rightValue], index) => {
    const y = 305 + index * 58;
    drawText(leftLabel, left + 16, y + 21, { size: 11, color: muted });
    drawText(leftValue, left + 16, y + 43, { size: 14, weight: 500 });
    drawText(rightLabel, midpoint + 16, y + 21, { size: 11, color: muted });
    drawText(rightValue, midpoint + 16, y + 43, { size: 14, weight: 500 });
    rect(border, left, y + 58, contentWidth, 1);
  });

  drawText('演示样本 · 不可作为交易凭证', left, 520, {
    size: 12,
    color: sampleInk,
    weight: 600,
  });
  drawText('1 / 1', right - 24, 520, { size: 10, color: muted });

  const image = await new Promise((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', 0.96),
  );
  if (!image) throw new Error('回单图像生成失败。');

  // 页面图像保留中文排版，透明文字层支持选中、搜索和复制。
  const characters = [...new Set(textRuns.flatMap(({ value }) => [...value]))];
  const codes = new Map(
    characters.map((character, index) => [
      character,
      (index + 33).toString(16),
    ]),
  );
  const mappings = characters.map((character) => {
    const utf16 = character
      .split('')
      .map((unit) => unit.charCodeAt(0).toString(16).padStart(4, '0'))
      .join('');
    return `<${codes.get(character)}> <${utf16}>`;
  });
  const mappingBlocks = [];
  for (let index = 0; index < mappings.length; index += 100) {
    const block = mappings.slice(index, index + 100);
    mappingBlocks.push(
      `${block.length} beginbfchar\n${block.join('\n')}\nendbfchar`,
    );
  }
  const unicodeMap = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /ReceiptText def /CMapType 2 def',
    '1 begincodespacerange <00> <FF> endcodespacerange',
    ...mappingBlocks,
    'endcmap CMapName currentdict /CMap defineresource pop end end',
  ].join('\n');

  const textCommands = textRuns.map(({ value, x, y, size, width }) => {
    const letters = [...value];
    const encodedValue = letters
      .map((character) => codes.get(character))
      .join('');
    const characterWidth = (width / (letters.length * 0.6)).toFixed(4);
    const baseline = (pageHeight - y).toFixed(2);
    return `${characterWidth} 0 0 ${size.toFixed(4)} ${x.toFixed(2)} ${baseline} Tm <${encodedValue}> Tj`;
  });
  const pageCommands = [
    `q ${pageWidth} 0 0 ${pageHeight} 0 0 cm /Receipt Do Q`,
    'BT /F1 1 Tf 3 Tr',
    ...textCommands,
    'ET',
  ].join('\n');

  function stream(data, dictionary = '') {
    const length = typeof data === 'string' ? data.length : data.size;
    return [
      `<< /Length ${length} ${dictionary} >>\nstream\n`,
      data,
      '\nendstream',
    ];
  }

  const objects = [
    ['<< /Type /Catalog /Pages 2 0 R >>'],
    ['<< /Type /Pages /Count 1 /Kids [3 0 R] >>'],
    [
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Receipt 4 0 R >> /Font << /F1 6 0 R >> >> /Contents 5 0 R >>`,
    ],
    stream(
      image,
      `/Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`,
    ),
    stream(pageCommands),
    [
      '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding /ToUnicode 7 0 R >>',
    ],
    stream(unicodeMap),
  ];

  const header = '%PDF-1.4\n';
  const binaryMarker = new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]);
  const chunks = [header, binaryMarker];
  const offsets = ['0000000000 65535 f \n'];
  let offset = header.length + binaryMarker.length;
  // 除 JPEG 数据外，PDF 结构和十六进制文字均为 ASCII，字符数等于字节数。
  objects.forEach((object, index) => {
    offsets.push(`${String(offset).padStart(10, '0')} 00000 n \n`);
    const parts = [`${index + 1} 0 obj\n`, ...object, '\nendobj\n'];
    chunks.push(...parts);
    offset += parts.reduce(
      (length, part) =>
        length + (typeof part === 'string' ? part.length : part.size),
      0,
    );
  });
  chunks.push(
    `xref\n0 ${offsets.length}\n${offsets.join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`,
  );

  return new Blob(chunks, { type: 'application/pdf' });
}
