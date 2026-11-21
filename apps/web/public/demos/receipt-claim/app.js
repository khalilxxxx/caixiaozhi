(() => {
  const form = document.querySelector('.query-form');
  const order = document.querySelector('#order-number');
  const amount = document.querySelector('#amount');
  const orderError = document.querySelector('#order-error');
  const amountError = document.querySelector('#amount-error');
  const submit = form.querySelector('button[type="submit"]');
  const submitLabel = document.querySelector('#query-label');
  const results = document.querySelector('#results-surface');
  const resultState = document.querySelector('#result-state');
  const stateText = document.querySelector('#state-text');
  const resultCount = document.querySelector('#result-count');
  const announcement = document.querySelector('#query-announcement');
  const receipt = document.querySelector('#receipt');
  const receiptOrder = document.querySelector('#receipt-order');
  const receiptAmount = document.querySelector('#receipt-amount');
  const preview = document.querySelector('#preview');
  const download = document.querySelector('#download');

  let receiptUrl;

  function setError(input, error, text) {
    error.textContent = text;
    error.hidden = !text;
    if (text) {
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', error.id);
    } else {
      input.removeAttribute('aria-invalid');
      input.removeAttribute('aria-describedby');
    }
  }

  function parseAmount(value) {
    const normalized = value.trim().normalize('NFKC');
    if (!/^(?:\d{1,12}|\d{1,3}(?:,\d{3}){1,3})(?:\.\d{1,2})?$/.test(normalized)) {
      return { error: '请输入有效金额，最多保留两位小数。' };
    }

    const [yuan, fraction = ''] = normalized.replaceAll(',', '').split('.');
    const whole = Number(yuan);
    if (whole === 0 && Number(fraction) === 0) {
      return { error: '金额须大于 0。' };
    }

    return { formatted: `${whole.toLocaleString('zh-CN')}.${fraction.padEnd(2, '0')}` };
  }

  function showState(kind, text) {
    receipt.hidden = true;
    resultCount.hidden = true;
    resultState.hidden = false;
    resultState.dataset.kind = kind;
    stateText.textContent = text;
    announcement.textContent = kind === 'empty' ? '' : text;
  }

  function clearReceipt() {
    if (!receiptUrl) return;

    URL.revokeObjectURL(receiptUrl);
    receiptUrl = undefined;
    preview.removeAttribute('href');
    download.removeAttribute('href');
    download.removeAttribute('download');
  }

  function updateInput(input, error) {
    setError(input, error, '');
    clearReceipt();
    showState('empty', '暂无查询结果');
  }

  function setPending(pending) {
    submit.disabled = pending;
    order.readOnly = pending;
    amount.readOnly = pending;
    results.setAttribute('aria-busy', String(pending));
    submitLabel.textContent = pending ? '查询中…' : '查询回单';
  }

  order.addEventListener('input', () => updateInput(order, orderError));
  amount.addEventListener('input', () => updateInput(amount, amountError));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submit.disabled) return;

    const orderNumber = order.value.trim();
    const amountResult = amount.value.trim()
      ? parseAmount(amount.value)
      : { error: '请输入金额。' };

    setError(order, orderError, orderNumber ? '' : '请输入单号。');
    setError(amount, amountError, amountResult.error || '');
    if (!orderNumber || amountResult.error) {
      (orderNumber ? amount : order).focus();
      return;
    }

    clearReceipt();
    setPending(true);
    showState('loading', '正在查询回单');

    try {
      const [pdf] = await Promise.all([
        createReceiptPdf({ orderNumber, amount: amountResult.formatted }),
        new Promise((resolve) => setTimeout(resolve, 400)),
      ]);

      receiptUrl = URL.createObjectURL(pdf);
      const filenameOrder = orderNumber.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-');
      receiptOrder.textContent = orderNumber;
      receiptAmount.textContent = `¥${amountResult.formatted}`;
      preview.href = receiptUrl;
      download.href = receiptUrl;
      download.download = `银行电子回单_${filenameOrder}.pdf`;

      resultState.hidden = true;
      receipt.hidden = false;
      resultCount.hidden = false;
      announcement.textContent = '已找到 1 份样本回单';
    } catch (error) {
      console.error(error);
      showState('error', '暂时无法生成回单，请重试。');
    } finally {
      setPending(false);
    }
  });

  document.querySelector('#use-example').addEventListener('click', () => {
    if (submit.disabled) return;

    order.value = 'FK-20261121-0024';
    amount.value = '12,580.00';
    updateInput(order, orderError);
    updateInput(amount, amountError);
    document.querySelector('#guide').hidePopover();
    order.focus();
  });
})();
