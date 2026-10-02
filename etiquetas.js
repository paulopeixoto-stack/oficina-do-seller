/* Interface da página de etiquetas (o motor está em etiquetas-motor.js). */
(function (root) {
  'use strict';

  // ---------------- interface da página ----------------
  var $ = function (id) { return document.getElementById(id); };
  var drop = $('drop');
  if (!drop) return; // motor carregado fora da página de etiquetas

  pdfjsLib.GlobalWorkerOptions.workerSrc = 'pdf.worker.min.js';

  var file = $('file'), bar = $('bar'), barMsg = $('barMsg');
  var err = $('err'), errMsg = $('errMsg');
  var done = $('done'), doneMeta = $('doneMeta'), dl = $('dl'), dropTitle = $('dropTitle');
  var refazer = $('refazer'), lista = $('lista'), prevWrap = $('prevWrap'), prev = $('prev'), prevCap = $('prevCap');
  var busy = false, lastUrl = null, ultimoArquivo = null, ultimoNome = '', ultimoTipo = '';

  function show(el, on) { el.classList[on ? 'remove' : 'add']('hidden'); }
  function opcoes() {
    var t = $('tamanho').value.split('x');
    return {
      wMm: parseFloat(t[0]),
      hMm: parseFloat(t[1]),
      colunas: parseInt($('colunas').value, 10),
      separador: $('separador').checked,
      resumo: $('resumo').checked,
      dpi: parseInt($('dpi').value, 10)
    };
  }
  function fail(m) {
    busy = false;
    drop.classList.remove('busy');
    show(bar, false);
    errMsg.textContent = m;
    show(err, true);
    dropTitle.textContent = 'Selecionar arquivo de etiquetas';
  }
  function progresso(m) { barMsg.textContent = m; }

  function preencheLista(itens) {
    lista.innerHTML = '';
    var MAX = 8;
    itens.slice(0, MAX).forEach(function (g) {
      var li = document.createElement('li');
      var q = document.createElement('span'); q.className = 'qtd'; q.textContent = g.qtd + '×';
      var s = document.createElement('span'); s.className = 'sku'; s.textContent = g.sku;
      var t = document.createElement('span'); t.className = 'tit'; t.textContent = g.titulo || '';
      li.appendChild(q); li.appendChild(s); li.appendChild(t);
      lista.appendChild(li);
    });
    if (itens.length > MAX) {
      var mais = document.createElement('li');
      mais.className = 'mais';
      mais.textContent = '+ ' + (itens.length - MAX) + ' outros produtos (todos vão no arquivo)';
      lista.appendChild(mais);
    }
  }

  function mostraPrevia(bytes, pagina, o) {
    show(prevWrap, false);
    try {
      pdfjsLib.getDocument({ data: bytes.slice(0) }).promise.then(function (doc) {
        return doc.getPage(pagina || 1).then(function (p) {
          var vp = p.getViewport({ scale: 1 });
          var escala = Math.min(300 / vp.width, 200 / vp.height) * (window.devicePixelRatio || 1);
          var vp2 = p.getViewport({ scale: escala });
          prev.width = vp2.width; prev.height = vp2.height;
          prev.style.width = Math.round(vp2.width / (window.devicePixelRatio || 1)) + 'px';
          var ctx = prev.getContext('2d');
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, prev.width, prev.height);
          return p.render({ canvasContext: ctx, viewport: vp2, intent: 'print' }).promise;
        }).then(function () {
          prevCap.textContent = 'Prévia da primeira etiqueta em ' + o.wMm + '×' + o.hMm + ' mm';
          show(prevWrap, true);
          return doc.destroy();
        });
      }).catch(function () { show(prevWrap, false); });
    } catch (e) { show(prevWrap, false); }
  }

  // prévia a partir do bitmap do ZPL (1 = tinta)
  function mostraPreviaBitmap(p, o) {
    prev.width = p.w; prev.height = p.h;
    prev.style.width = Math.min(300, p.w) + 'px';
    var ctx = prev.getContext('2d'), img = ctx.createImageData(p.w, p.h), d = img.data;
    for (var y = 0; y < p.h; y++) for (var x = 0; x < p.w; x++) {
      var preto = (p.dados[y * p.nb + (x >> 3)] >> (7 - (x & 7))) & 1, k = (y * p.w + x) * 4;
      d[k] = d[k + 1] = d[k + 2] = preto ? 0 : 255; d[k + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    prevCap.textContent = 'Prévia da primeira etiqueta em ' + o.wMm + '×' + o.hMm + ' mm';
    show(prevWrap, true);
  }

  function terminou(res, blob, extensao, extraMeta) {
    var o = opcoes();
    if (lastUrl) URL.revokeObjectURL(lastUrl);
    lastUrl = URL.createObjectURL(blob);
    dl.href = lastUrl;
    // ".zpl" é associado ao Windows Media Player; o ZPL sai como .txt, igual ao arquivo do Seller Center.
    dl.download = 'ETIQUETAS_' + o.wMm + 'x' + o.hMm + '_' + ultimoNome.replace(/\.(pdf|txt)$/i, '') +
      (extensao === '.zpl' ? '_ZPL.txt' : extensao);
    dl.textContent = 'Baixar ' + (extensao === '.zpl' ? 'ZPL' : 'PDF');
    var meta = res.etiquetas + (res.etiquetas === 1 ? ' etiqueta' : ' etiquetas') +
      ' de ' + res.produtos + (res.produtos === 1 ? ' produto' : ' produtos') +
      ' · nenhuma foi removida' + (extraMeta || '');
    if (res.semCodigo) meta += ' · ' + res.semCodigo + ' sem código identificado';
    doneMeta.textContent = meta;
    preencheLista(res.lista || []);
    busy = false;
    drop.classList.remove('busy');
    show(bar, false);
    show(done, true);
    dropTitle.textContent = 'Converter outro arquivo';
    dl.focus();
  }

  function rodar() {
    if (!ultimoArquivo) return;
    busy = true;
    show(err, false);
    show(done, false);
    show(prevWrap, false);
    show(bar, true);
    drop.classList.add('busy');
    dropTitle.textContent = 'Processando ' + ultimoNome;
    progresso('Lendo o arquivo…');
    var o = opcoes();

    if (ultimoTipo === 'txt') {
      EtiquetasFull.processarTxt(ultimoArquivo, o, progresso).then(function (res) {
        var aviso = '';
        if (res.fator < 0.9) aviso = ' · atenção: a etiqueta ficou menor que a original, confira a leitura do QR antes de imprimir tudo';
        terminou(res, new Blob([res.zpl], { type: 'text/plain' }), '.zpl',
          ' · ZPL para impressora Zebra (' + o.dpi + ' dpi)' + aviso);
        if (res.previaBitmap) mostraPreviaBitmap(res.previaBitmap, o);
      }).catch(function (e) {
        fail(e && e.message ? e.message : 'Não consegui processar esse arquivo.');
      });
      return;
    }

    EtiquetasFull.processarPdf(ultimoArquivo, o, progresso).then(function (res) {
      var extra = res.paginasIgnoradas ? ' · ' + res.paginasIgnoradas + ' página(s) sem etiqueta foram ignoradas' : '';
      terminou(res, new Blob([res.bytes], { type: 'application/pdf' }), '.pdf', extra);
      mostraPrevia(res.bytes, res.primeiraPagina, o);
    }).catch(function (e) {
      fail(e && e.message ? e.message : 'Não consegui processar esse arquivo.');
    });
  }

  function handle(f) {
    if (busy || !f) return;
    var ehPdf = /\.pdf$/i.test(f.name), ehTxt = /\.txt$/i.test(f.name);
    if (!ehPdf && !ehTxt) return fail('Envie o arquivo de etiquetas baixado do Seller Center: .pdf (sai PDF) ou .txt (sai ZPL). Esse arquivo é ' + (f.name.split('.').pop() || 'de outro tipo') + '.');
    if (f.size > 60 * 1024 * 1024) return fail('O arquivo tem ' + (f.size / 1048576).toFixed(0) + ' MB. O limite é 60 MB.');
    if (ehTxt) {
      f.text().then(function (t) {
        ultimoArquivo = t;
        ultimoNome = f.name;
        ultimoTipo = 'txt';
        rodar();
      });
      return;
    }
    f.arrayBuffer().then(function (ab) {
      ultimoArquivo = ab;
      ultimoNome = f.name;
      ultimoTipo = 'pdf';
      rodar();
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
  refazer.addEventListener('click', function () { if (!busy) rodar(); });

  // ---- relato de erro (mesmo Web3Forms do conversor) ----
  var WEB3FORMS_KEY = '87cc3a2d-45bf-47e5-b494-719a6f1d69b5';
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
    fetch('https://api.web3forms.com/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        access_key: WEB3FORMS_KEY,
        subject: 'Oficina Etiquetas — ' + $('reason').value,
        from_name: 'Redimensionador de etiquetas',
        'Motivo': $('reason').value,
        'E-mail do seller': $('email').value,
        'ShopId ou link da loja': $('shopid').value || '(não informado)',
        'Detalhes': $('details').value || '(sem detalhes)',
        'Navegador': navigator.userAgent,
        botcheck: false
      })
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
})(typeof module !== 'undefined' && module.exports ? module.exports : window);
