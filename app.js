(function () {
  'use strict';

  var WEB3FORMS_KEY = '87cc3a2d-45bf-47e5-b494-719a6f1d69b5';
  var TEMPLATE_URL = 'template-shopee.xlsx';
  var MAX_MB = 25;

  var $ = function (id) { return document.getElementById(id); };
  var drop = $('drop'), file = $('file'), bar = $('bar');
  var err = $('err'), errMsg = $('errMsg');
  var done = $('done'), doneMeta = $('doneMeta'), dl = $('dl'), dropTitle = $('dropTitle');
  var lastUrl = null, templateBytes = null, busy = false;

  function show(el, on) { el.classList[on ? 'remove' : 'add']('hidden'); }

  function fail(message) {
    busy = false;
    drop.classList.remove('busy');
    show(bar, false);
    errMsg.textContent = message;
    show(err, true);
    dropTitle.textContent = 'Arraste a planilha do Mercado Livre';
  }

  function loadTemplate() {
    if (templateBytes) return Promise.resolve(templateBytes);
    // Versão offline: o template vem embutido na própria página.
    if (window.__TEMPLATE_B64) {
      var raw = atob(window.__TEMPLATE_B64), n = raw.length, arr = new Uint8Array(n);
      for (var i = 0; i < n; i++) arr[i] = raw.charCodeAt(i);
      templateBytes = arr.buffer;
      return Promise.resolve(templateBytes);
    }
    return fetch(TEMPLATE_URL).then(function (r) {
      if (!r.ok) throw new Error('Não consegui carregar o template da Shopee. Recarregue a página e tente de novo.');
      return r.arrayBuffer();
    }).then(function (b) { templateBytes = b; return b; });
  }

  function handle(f) {
    if (busy || !f) return;
    if (!/\.xlsx$/i.test(f.name)) {
      return fail('Envie o arquivo .xlsx exportado do Mercado Livre. Esse arquivo é ' +
        (f.name.split('.').pop() || 'de outro tipo') + '.');
    }
    if (f.size > MAX_MB * 1024 * 1024) {
      return fail('O arquivo tem ' + (f.size / 1048576).toFixed(1) + ' MB. O limite é ' + MAX_MB + ' MB.');
    }

    busy = true;
    show(err, false);
    show(done, false);
    show(bar, true);
    drop.classList.add('busy');
    dropTitle.textContent = 'Convertendo ' + f.name;

    Promise.all([f.arrayBuffer(), loadTemplate()])
      .then(function (bufs) {
        return Promise.all([JSZip.loadAsync(bufs[0]), JSZip.loadAsync(bufs[1])]);
      })
      .then(function (zips) {
        return window.MLShopee.convert(zips[0], zips[1], JSZip);
      })
      .then(function (res) {
        var blob = new Blob([res.bytes], {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        });
        if (lastUrl) URL.revokeObjectURL(lastUrl);
        lastUrl = URL.createObjectURL(blob);
        dl.href = lastUrl;
        dl.download = 'SHOPEE_Regras_Fiscais_from_' + f.name.replace(/\.xlsx$/i, '') + '.xlsx';

        var bits = [res.rules + (res.rules === 1 ? ' regra' : ' regras'), res.rows + ' linhas'];
        if (res.dropped) {
          bits.push(res.dropped + (res.dropped === 1 ? ' regra repetida foi unificada' : ' regras repetidas foram unificadas'));
        }
        doneMeta.textContent = bits.join(' · ');

        busy = false;
        drop.classList.remove('busy');
        show(bar, false);
        show(done, true);
        dropTitle.textContent = 'Converter outra planilha';
        dl.focus();
      })
      .catch(function (e) {
        fail(e && e.message ? e.message : 'Não consegui converter esse arquivo.');
      });
  }

  drop.addEventListener('click', function () { if (!busy) file.click(); });
  file.addEventListener('change', function () { handle(file.files[0]); file.value = ''; });

  ['dragenter', 'dragover'].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); if (!busy) drop.classList.add('drag'); });
  });
  ['dragleave', 'dragend', 'drop'].forEach(function (ev) {
    drop.addEventListener(ev, function () { drop.classList.remove('drag'); });
  });
  drop.addEventListener('drop', function (e) {
    e.preventDefault();
    if (e.dataTransfer && e.dataTransfer.files.length) handle(e.dataTransfer.files[0]);
  });
  ['dragover', 'drop'].forEach(function (ev) {
    window.addEventListener(ev, function (e) { e.preventDefault(); });
  });

  // ---- relato de erro ----
  var report = $('report'), openReport = $('openReport'), closeReport = $('closeReport');
  var form = $('reportForm'), status = $('reportStatus'), send = $('reportSend');

  openReport.addEventListener('click', function () {
    show(report, true);
    openReport.parentNode.classList.add('hidden');
    $('reason').focus();
  });
  closeReport.addEventListener('click', function () {
    show(report, false);
    openReport.parentNode.classList.remove('hidden');
    status.textContent = '';
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!$('reason').value) { status.textContent = 'Escolha o que aconteceu.'; return; }
    if (!$('email').checkValidity()) { status.textContent = 'Confira o e-mail digitado.'; return; }

    send.disabled = true;
    status.textContent = 'Enviando…';

    var payload = {
      access_key: WEB3FORMS_KEY,
      subject: 'Conversor Shopee — ' + $('reason').value,
      from_name: 'Conversor de regras tributárias',
      'Motivo': $('reason').value,
      'E-mail do seller': $('email').value,
      'Detalhes': $('details').value || '(sem detalhes)',
      'Navegador': navigator.userAgent,
      botcheck: false
    };

    fetch('https://api.web3forms.com/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.success) throw new Error(d.message || 'falha no envio');
        form.reset();
        status.textContent = 'Relato enviado. Entraremos em contato pelo e-mail informado.';
        send.disabled = true;
      })
      .catch(function () {
        status.textContent = 'Não consegui enviar agora. Tente novamente em alguns minutos.';
        send.disabled = false;
      });
  });
})();
