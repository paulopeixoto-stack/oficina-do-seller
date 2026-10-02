/* Motor do redimensionador de etiquetas do Full.
   Princípio: a arte oficial da Shopee (QR Code incluso) NUNCA é redesenhada — só é recortada,
   movida e redimensionada. A quantidade que entra é a quantidade que sai.
   Entradas aceitas:
     - PDF "um código de barras por página" (60×40)      -> PDF
     - PDF A4 (grade de mini-etiquetas) e A5              -> PDF
     - .txt "Impressora Térmica" (ZPL com a etiqueta em imagem) -> ZPL
   Tudo roda no navegador; nada é enviado a servidor. */
(function (root) {
  'use strict';

  var MM = 72 / 25.4;
  var FOLGA_MM = 3;   // vão entre as colunas
  var LOTE = 40;      // páginas processadas por respiro do navegador

  function respiro() { return new Promise(function (ok) { setTimeout(ok, 0); }); }

  // Helvetica só aceita WinAnsi; troca o que não dá para desenhar.
  function latin(s) {
    s = String(s == null ? '' : s).normalize('NFKC');
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      out += (c >= 32 && c <= 126) || (c >= 160 && c <= 255) ? s[i] : '?';
    }
    return out;
  }
  function corta(font, s, size, maxW) {
    if (font.widthOfTextAtSize(s, size) <= maxW) return s;
    while (s.length > 1 && font.widthOfTextAtSize(s + '…', size) > maxW) s = s.slice(0, -1);
    return s + '…';
  }

  // =====================================================================
  //  PDF: leitura
  // =====================================================================
  function tamanhoPerto(wPt, hPt, a, b) {
    var wm = wPt / MM, hm = hPt / MM, t = 3;
    return (Math.abs(wm - a) <= t && Math.abs(hm - b) <= t) || (Math.abs(wm - b) <= t && Math.abs(hm - a) <= t);
  }

  // posições (em pontos, origem embaixo à esquerda) das imagens desenhadas na página
  function imagensDaPagina(page) {
    var O = pdfjsLib.OPS;
    return page.getOperatorList().then(function (ops) {
      var ctm = [1, 0, 0, 1, 0, 0], pilha = [], imgs = [];
      var mul = function (m, n) {
        return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
                m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
                m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
      };
      for (var i = 0; i < ops.fnArray.length; i++) {
        var f = ops.fnArray[i], a = ops.argsArray[i];
        if (f === O.save) pilha.push(ctm.slice());
        else if (f === O.restore) ctm = pilha.pop() || ctm;
        else if (f === O.transform) ctm = mul(ctm, a);
        else if (f === O.paintImageXObject || f === O.paintInlineImageXObject || f === O.paintImageMaskXObject) {
          var w = Math.abs(ctm[0]), h = Math.abs(ctm[3]);
          if (w >= 20 && w <= 160 && h >= 20 && h <= 160) imgs.push({ x: ctm[4], y: ctm[5], w: w, h: h });
        }
      }
      return imgs;
    });
  }

  // Alguns PDFs desenham o "_" do código como espaço; o código é tudo depois dos dois-pontos.
  var RE_SELLER = /^seller\s*sku\s*:\s*(.+)$/i;
  var RE_WHS = /^whs\s*sku\s*id\s*:\s*(.+)$/i;
  var RE_SHOP = /^shop\s*sku\s*id\s*:\s*(.+)$/i;
  function codigo(s) { return String(s).trim().replace(/\s+/g, '_'); }
  var RE_META = /^(seller\s*sku|barcode|whs\s*skuid|whs\s*sku\s*id|shop\s*sku\s*id)\s*:/i;

  // Página 60×40: uma etiqueta que ocupa a página inteira.
  function etiquetaPaginaInteira(indice, itens) {
    var linhas = itens.map(function (it) { return it.s; });
    var texto = linhas.join('\n');
    var sku = /seller\s*sku\s*:\s*(\S+)/im.exec(texto);
    var bar = /barcode\s*:\s*(\S+)/im.exec(texto);
    var tit = [];
    for (var i = 0; i < linhas.length; i++) {
      if (RE_META.test(linhas[i])) break;
      if (linhas[i]) tit.push(linhas[i]);
    }
    return {
      pagina: indice, box: null,
      sku: sku ? sku[1] : '', barcode: bar ? bar[1] : '',
      titulo: tit.join(' ').replace(/[:\s]+$/, '').trim()
    };
  }

  // Página A4/A5: grade de mini-etiquetas. Cada QR é uma imagem; as linhas de texto abaixo dele
  // completam a etiqueta. A caixa de recorte sai do conteúdo real, não de medidas fixas.
  function etiquetasDaGrade(indice, itens, imgs) {
    imgs = imgs.slice().sort(function (a, b) {
      return Math.abs(b.y - a.y) > 10 ? b.y - a.y : a.x - b.x;
    });
    var grupos = imgs.map(function () { return []; });
    itens.forEach(function (it) {
      var cx = it.x + it.w / 2, melhor = -1, dist = 1e9;
      imgs.forEach(function (im, k) {
        var d = Math.abs(cx - (im.x + im.w / 2));
        if (it.y < im.y + 1 && it.y > im.y - 34 && d < dist && d < im.w * 1.4) { dist = d; melhor = k; }
      });
      if (melhor >= 0) grupos[melhor].push(it);
    });
    var out = [];
    imgs.forEach(function (im, k) {
      var ls = grupos[k].sort(function (a, b) { return b.y - a.y; });
      if (!ls.length) return;
      var sku = '', whs = '', resto = [];
      ls.forEach(function (l) {
        var m;
        if ((m = RE_SELLER.exec(l.s))) sku = codigo(m[1]);
        else if ((m = RE_WHS.exec(l.s))) whs = codigo(m[1]);
        else if (RE_SHOP.test(l.s)) { /* repete o seller sku */ }
        else resto.push(l.s);
      });
      var esq = Math.min(im.x, Math.min.apply(null, ls.map(function (l) { return l.x; }))) - 1.5;
      var dir = Math.max(im.x + im.w, Math.max.apply(null, ls.map(function (l) { return l.x + l.w; }))) + 1.5;
      var base = Math.min.apply(null, ls.map(function (l) { return l.y; })) - 3;
      var topo = im.y + im.h + 1.5;
      out.push({
        pagina: indice,
        box: { x: esq, y: base, w: dir - esq, h: topo - base },
        sku: sku, barcode: whs,
        titulo: resto.join(' ').replace(/[:\s]+$/, '').trim()
      });
    });
    return out;
  }

  function lerEtiquetas(bytes, aoProgredir) {
    return pdfjsLib.getDocument({ data: bytes }).promise.then(function (doc) {
      var n = doc.numPages, etiquetas = [], paginasSemEtiqueta = 0, chain = Promise.resolve();
      var formatos = { pagina: 0, grade: 0 };

      function lerPagina(i) {
        return doc.getPage(i).then(function (page) {
          var vp = page.getViewport({ scale: 1 });
          var pequena = tamanhoPerto(vp.width, vp.height, 60, 40);
          return page.getTextContent().then(function (tc) {
            var itens = tc.items.filter(function (it) { return it.str && it.str.trim(); }).map(function (it) {
              return { s: it.str.trim(), x: it.transform[4], y: it.transform[5], w: it.width };
            });
            if (pequena) {
              formatos.pagina++;
              etiquetas.push(etiquetaPaginaInteira(i - 1, itens));
              page.cleanup();
              return;
            }
            return imagensDaPagina(page).then(function (imgs) {
              var achadas = imgs.length ? etiquetasDaGrade(i - 1, itens, imgs) : [];
              if (!achadas.length) paginasSemEtiqueta++;
              else formatos.grade++;
              achadas.forEach(function (e) { etiquetas.push(e); });
              page.cleanup();
            });
          });
        });
      }

      for (var i = 1; i <= n; i++) {
        (function (i) {
          chain = chain.then(function () {
            if (i % LOTE === 0) {
              if (aoProgredir) aoProgredir('Lendo página ' + i + ' de ' + n);
              return respiro().then(function () { return lerPagina(i); });
            }
            return lerPagina(i);
          });
        })(i);
      }
      return chain.then(function () {
        return doc.destroy().then(function () {
          return { etiquetas: etiquetas, total: n, paginasSemEtiqueta: paginasSemEtiqueta, formatos: formatos };
        });
      });
    });
  }

  // =====================================================================
  //  Agrupamento (nada é descartado; ordem da primeira aparição)
  // =====================================================================
  function agrupar(etiquetas) {
    var grupos = [], porChave = {};
    etiquetas.forEach(function (e) {
      var chave = e.sku || e.barcode || '(sem código)';
      if (!Object.prototype.hasOwnProperty.call(porChave, chave)) {
        porChave[chave] = grupos.length;
        grupos.push({ chave: chave, titulo: e.titulo, itens: [] });
      }
      grupos[porChave[chave]].itens.push(e);
    });
    return grupos;
  }

  // =====================================================================
  //  PDF: montagem
  // =====================================================================
  function montar(bytes, grupos, opts, aoProgredir) {
    var PDFDocument = PDFLib.PDFDocument, StandardFonts = PDFLib.StandardFonts, rgb = PDFLib.rgb;
    var wEt = opts.wMm * MM, hEt = opts.hMm * MM;
    var cols = opts.colunas === 2 ? 2 : 1;
    var gap = cols === 2 ? FOLGA_MM * MM : 0;
    var pW = cols === 2 ? wEt * 2 + gap : wEt, pH = hEt;
    var preto = rgb(0, 0, 0), cinza = rgb(0.35, 0.35, 0.35);

    return PDFDocument.load(bytes, { ignoreEncryption: true }).then(function (src) {
      return PDFDocument.create().then(function (out) {
        return Promise.all([out.embedFont(StandardFonts.Helvetica), out.embedFont(StandardFonts.HelveticaBold)]).then(function (fonts) {
          var fnt = fonts[0], bold = fonts[1];

          // páginas de origem realmente usadas, cada uma incorporada uma única vez
          var usadas = [], seen = {};
          grupos.forEach(function (g) { g.itens.forEach(function (e) {
            if (!seen[e.pagina]) { seen[e.pagina] = true; usadas.push(e.pagina); }
          }); });
          var totalEtiquetas = grupos.reduce(function (s, g) { return s + g.itens.length; }, 0);

          return out.embedPdf(src, usadas).then(function (embutidas) {
            var porPagina = {};
            usadas.forEach(function (idx, k) { porPagina[idx] = embutidas[k]; });

            var paginaAtual = null, celula = 0, desenhadas = 0, primeiraPagina = null;

            function novaPagina() { paginaAtual = out.addPage([pW, pH]); celula = 0; }

            function desenha(e) {
              if (!paginaAtual || celula >= cols) novaPagina();
              var emb = porPagina[e.pagina];
              var x0 = celula * (wEt + gap);
              if (!e.box) {
                var s0 = Math.min(wEt / emb.width, hEt / emb.height);
                paginaAtual.drawPage(emb, {
                  x: x0 + (wEt - emb.width * s0) / 2, y: (hEt - emb.height * s0) / 2, xScale: s0, yScale: s0
                });
              } else {
                var b = e.box, s = Math.min(wEt / b.w, hEt / b.h);
                var cw = b.w * s, ch = b.h * s;
                var cx = x0 + (wEt - cw) / 2, cy = (hEt - ch) / 2;
                paginaAtual.pushOperators(PDFLib.pushGraphicsState(), PDFLib.rectangle(cx, cy, cw, ch), PDFLib.clip(), PDFLib.endPath());
                paginaAtual.drawPage(emb, { x: cx - b.x * s, y: cy - b.y * s, xScale: s, yScale: s });
                paginaAtual.pushOperators(PDFLib.popGraphicsState());
              }
              celula++;
            }

            // quebra o texto em até 'maxLinhas' linhas; reduz a fonte até caber
            function quebra(font, texto, tamMax, tamMin, maxW, maxLinhas) {
              for (var tam = tamMax; tam >= tamMin - 0.01; tam -= 0.5) {
                var palavras = texto.split(/\s+/), linhas = [], atual = '';
                for (var i = 0; i < palavras.length; i++) {
                  var teste = atual ? atual + ' ' + palavras[i] : palavras[i];
                  if (font.widthOfTextAtSize(teste, tam) <= maxW) atual = teste;
                  else { if (atual) linhas.push(atual); atual = palavras[i]; }
                }
                if (atual) linhas.push(atual);
                if (linhas.length <= maxLinhas && linhas.every(function (l) { return font.widthOfTextAtSize(l, tam) <= maxW; })) return { tam: tam, linhas: linhas };
              }
              var t = tamMin, ls = [corta(font, texto, t, maxW)];
              return { tam: t, linhas: ls };
            }
            function separadora(g) {
              var p = out.addPage([pW, pH]), m = 4 * MM, maxW = pW - 2 * m;
              p.drawRectangle({ x: 1.5, y: 1.5, width: pW - 3, height: pH - 3, borderColor: preto, borderWidth: 1 });
              var tit = quebra(bold, latin(g.titulo || '(sem descrição)'), Math.min(11, pH * 0.16), 5.5, maxW, 3);
              var y = pH - m - tit.tam;
              tit.linhas.forEach(function (l) { p.drawText(l, { x: m, y: y, size: tit.tam, font: bold, color: preto }); y -= tit.tam + 1.5; });
              var sku = quebra(fnt, 'SKU: ' + latin(g.chave), Math.min(9, pH * 0.12), 5.5, maxW, 1);
              p.drawText(sku.linhas[0], { x: m, y: y - 2, size: sku.tam, font: fnt, color: preto });
              p.drawText(g.itens.length + (g.itens.length === 1 ? ' etiqueta' : ' etiquetas'), { x: m, y: m, size: Math.max(6, Math.min(9, pH * 0.12)), font: fnt, color: cinza });
            }

            var chain = Promise.resolve();
            grupos.forEach(function (g) {
              chain = chain.then(function () {
                if (opts.separador) { separadora(g); paginaAtual = null; }
                var sub = Promise.resolve();
                g.itens.forEach(function (e) {
                  sub = sub.then(function () {
                    desenha(e);
                    desenhadas++;
                    if (desenhadas === 1) primeiraPagina = out.getPageCount();
                    if (desenhadas % (LOTE * 2) === 0) {
                      if (aoProgredir) aoProgredir('Montando etiqueta ' + desenhadas + ' de ' + totalEtiquetas);
                      return respiro();
                    }
                  });
                });
                return sub.then(function () { paginaAtual = null; });
              });
            });

            return chain.then(function () {
              if (opts.resumo) {
                var linhas = grupos.map(function (g) { return g.itens.length + 'x  ' + latin(g.chave) + ' - ' + latin(g.titulo || ''); });
                var tam = Math.max(5, Math.min(7, pH * 0.09)), passo = tam + 2.2, m2 = 3 * MM, topo = 11;
                var porPag = Math.max(3, Math.floor((pH - m2 - topo - m2) / passo));
                for (var i = 0; i < linhas.length; i += porPag) {
                  var p = out.addPage([pW, pH]);
                  p.drawText('RESUMO  -  ' + totalEtiquetas + ' etiquetas, ' + grupos.length + ' produtos', { x: m2, y: pH - m2 - 8, size: Math.min(8, tam + 1), font: bold, color: preto });
                  linhas.slice(i, i + porPag).forEach(function (l, j) {
                    p.drawText(corta(fnt, l, tam, pW - 2 * m2), { x: m2, y: pH - m2 - topo - (j + 1) * passo, size: tam, font: fnt, color: preto });
                  });
                }
              }
              if (aoProgredir) aoProgredir('Gravando o arquivo…');
              return out.save().then(function (b) { return { bytes: b, paginasSaida: out.getPageCount(), primeiraPagina: primeiraPagina }; });
            });
          });
        });
      });
    });
  }

  function processarPdf(arrayBuffer, opts, aoProgredir) {
    var b = new Uint8Array(arrayBuffer);
    return lerEtiquetas(b.slice(0), aoProgredir).then(function (leitura) {
      if (leitura.total === 0) throw new Error('Este PDF não tem páginas.');
      if (!leitura.etiquetas.length) {
        throw new Error('Não encontrei etiquetas neste PDF. Use o arquivo baixado em "Imprimir Etiqueta de Item" (Ver Detalhes da solicitação de envio): ' +
          '"Um código de barras por página (60×40)", "A4" ou "A5".');
      }
      var grupos = agrupar(leitura.etiquetas);
      var semCodigo = leitura.etiquetas.filter(function (e) { return !e.sku && !e.barcode; }).length;
      return montar(b.slice(0), grupos, opts, aoProgredir).then(function (r) {
        return {
          tipo: 'pdf', bytes: r.bytes,
          etiquetas: leitura.etiquetas.length, produtos: grupos.length, semCodigo: semCodigo,
          paginasSaida: r.paginasSaida, primeiraPagina: r.primeiraPagina,
          paginasIgnoradas: leitura.paginasSemEtiqueta,
          formato: leitura.formatos.grade ? 'grade' : 'pagina',
          lista: grupos.map(function (g) { return { sku: g.chave, titulo: g.titulo, qtd: g.itens.length }; })
        };
      });
    });
  }

  // =====================================================================
  //  .txt "Impressora Térmica": ZPL com a etiqueta em imagem (~DG ... Z64)
  // =====================================================================
  function b64ParaBytes(b64) {
    var bin = atob(b64), u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }
  function inflar(bytes) {
    if (typeof DecompressionStream === 'undefined') {
      return Promise.reject(new Error('Seu navegador é muito antigo para ler este arquivo. Atualize o Chrome, Edge, Firefox ou Safari.'));
    }
    var ds = new DecompressionStream('deflate');
    var w = ds.writable.getWriter();
    w.write(bytes); w.close();
    return new Response(ds.readable).arrayBuffer().then(function (ab) { return new Uint8Array(ab); });
  }
  function hexParaBytes(h) {
    var u = new Uint8Array(h.length >> 1);
    for (var i = 0; i < u.length; i++) u[i] = parseInt(h.substr(i * 2, 2), 16);
    return u;
  }

  // Folhas (bitmaps) do arquivo, em ordem.
  function lerFolhasZpl(texto, aoProgredir) {
    var re = /~DG[A-Z]?:[^,]*,(\d+),(\d+),(:Z64:([A-Za-z0-9+\/=]+):[0-9A-Fa-f]{4}|[0-9A-Fa-f\s]+?)(?=\s*[\^~]|\s*$)/g;
    var achados = [], m;
    while ((m = re.exec(texto))) achados.push({ total: +m[1], bpl: +m[2], z64: m[4], hex: m[4] ? null : m[3].replace(/\s+/g, '') });
    if (!achados.length) return Promise.resolve([]);
    var folhas = [], chain = Promise.resolve();
    achados.forEach(function (a, k) {
      chain = chain.then(function () {
        var p = a.z64 ? inflar(b64ParaBytes(a.z64)) : Promise.resolve(hexParaBytes(a.hex));
        return p.then(function (dados) {
          if (dados.length >= a.total && a.bpl > 0) folhas.push({ dados: dados.subarray(0, a.total), bpl: a.bpl });
          if (aoProgredir && k % 20 === 19) { aoProgredir('Lendo folha ' + (k + 1) + ' de ' + achados.length); return respiro(); }
        });
      });
    });
    return chain.then(function () { return folhas; });
  }

  // Corta as mini-etiquetas de uma folha: faixas de linhas com tinta, e dentro delas blocos de colunas.
  function recortarCelulas(folha) {
    var d = folha.dados, bpl = folha.bpl, w = bpl * 8, h = Math.floor(d.length / bpl);
    function linhaTemTinta(y) { for (var x = 0; x < bpl; x++) if (d[y * bpl + x]) return true; return false; }
    var faixas = [], y = 0, GAP_Y = 18;
    while (y < h) {
      while (y < h && !linhaTemTinta(y)) y++;
      if (y >= h) break;
      var ini = y, vazias = 0, fim = y;
      while (y < h && vazias < GAP_Y) { if (linhaTemTinta(y)) { vazias = 0; fim = y; } else vazias++; y++; }
      faixas.push([ini, fim]);
    }
    var celulas = [];
    faixas.forEach(function (f) {
      var tinta = new Uint8Array(w);
      for (var yy = f[0]; yy <= f[1]; yy++) for (var xb = 0; xb < bpl; xb++) {
        var v = d[yy * bpl + xb];
        if (v) for (var bit = 0; bit < 8; bit++) if (v & (0x80 >> bit)) tinta[xb * 8 + bit] = 1;
      }
      var blocos = [], x = 0, GAP_X = 8;
      while (x < w) {
        while (x < w && !tinta[x]) x++;
        if (x >= w) break;
        var ix = x, vz = 0, fx = x;
        while (x < w && vz < GAP_X) { if (tinta[x]) { vz = 0; fx = x; } else vz++; x++; }
        blocos.push([ix, fx]);
      }
      blocos.forEach(function (bl) {
        var cw = bl[1] - bl[0] + 1, ch = f[1] - f[0] + 1;
        celulas.push(extrair(d, bpl, bl[0], f[0], cw, ch));
      });
    });
    return celulas;
  }
  // recorta um retângulo para um bitmap novo (largura alinhada em bytes)
  function extrair(d, bpl, x0, y0, cw, ch) {
    var nb = Math.ceil(cw / 8), out = new Uint8Array(nb * ch);
    for (var y = 0; y < ch; y++) for (var x = 0; x < cw; x++) {
      var sx = x0 + x, sy = y0 + y;
      if (d[sy * bpl + (sx >> 3)] & (0x80 >> (sx & 7))) out[y * nb + (x >> 3)] |= (0x80 >> (x & 7));
    }
    return { dados: out, w: cw, h: ch, nb: nb };
  }
  function pixel(c, x, y) { return (c.dados[y * c.nb + (x >> 3)] >> (7 - (x & 7))) & 1; }

  // Reamostragem: ampliar repete pixels (módulos do QR continuam nítidos); reduzir usa a média da área
  // coberta e pinta o pixel se mais da metade dela era tinta.
  function escalar(c, fator) {
    if (Math.abs(fator - 1) < 0.001) return c;
    var nw = Math.max(1, Math.round(c.w * fator)), nh = Math.max(1, Math.round(c.h * fator));
    var nb = Math.ceil(nw / 8), out = new Uint8Array(nb * nh), x, y;
    for (y = 0; y < nh; y++) for (x = 0; x < nw; x++) {
      var tinta;
      if (fator >= 1) {
        tinta = pixel(c, Math.min(c.w - 1, Math.floor(x / fator)), Math.min(c.h - 1, Math.floor(y / fator)));
      } else {
        var x0 = x / fator, x1 = Math.min(c.w, (x + 1) / fator), y0 = y / fator, y1 = Math.min(c.h, (y + 1) / fator);
        var soma = 0, area = 0;
        for (var sy = Math.floor(y0); sy < Math.ceil(y1); sy++) for (var sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
          var cob = (Math.min(sx + 1, x1) - Math.max(sx, x0)) * (Math.min(sy + 1, y1) - Math.max(sy, y0));
          if (cob > 0) { area += cob; if (pixel(c, sx, sy)) soma += cob; }
        }
        tinta = area > 0 && soma / area >= 0.5 ? 1 : 0;
      }
      if (tinta) out[y * nb + (x >> 3)] |= (0x80 >> (x & 7));
    }
    return { dados: out, w: nw, h: nh, nb: nb };
  }

  function linhaVazia(c, y) { for (var i = 0; i < c.nb; i++) if (c.dados[y * c.nb + i]) return false; return true; }
  function fatiar(c, y0, y1) { return extrair(c.dados, c.nb, 0, y0, c.w, y1 - y0); }
  function compor(partes, w, h) {
    var nb = Math.ceil(w / 8), out = new Uint8Array(nb * h);
    partes.forEach(function (p) {
      for (var y = 0; y < p.c.h; y++) for (var x = 0; x < p.c.w; x++) {
        if (pixel(p.c, x, y)) { var dx = p.x + x, dy = p.y + y; out[dy * nb + (dx >> 3)] |= (0x80 >> (dx & 7)); }
      }
    });
    return { dados: out, w: w, h: h, nb: nb };
  }
  // Quando a etiqueta é maior que a bobina, só o QR encolhe (ele tolera); o texto miúdo abaixo dele
  // mantém o tamanho original, porque encolher traços de 1 ponto os destrói.
  function encolherSoQr(c, maxW, maxH) {
    var y = Math.floor(c.h * 0.6), corte = -1;
    for (; y < c.h; y++) if (linhaVazia(c, y)) { corte = y; break; }
    if (corte < 0) return null;
    var t0 = corte;
    while (t0 < c.h && linhaVazia(c, t0)) t0++;
    if (t0 >= c.h) return null;
    var qr = fatiar(c, 0, corte), texto = fatiar(c, t0, c.h), vao = 3;
    var f = Math.min(1, (maxH - texto.h - vao) / qr.h, maxW / qr.w);
    if (f < 0.75 || texto.w > maxW) return null;
    var qr2 = escalar(qr, f), W = Math.max(qr2.w, texto.w);
    return { cel: compor([{ c: qr2, x: Math.floor((W - qr2.w) / 2), y: 0 },
                          { c: texto, x: Math.floor((W - texto.w) / 2), y: qr2.h + vao }], W, qr2.h + vao + texto.h), fator: f };
  }

  // Assinatura grosseira do desenho (fração de tinta por bloco). As cópias de uma mesma etiqueta variam alguns
  // pixels conforme a posição na folha; a assinatura ignora esse ruído e ainda separa produtos diferentes.
  // Só a área do QR (topo da etiqueta) entra na comparação: é ela que identifica o produto, e o texto
  // abaixo só diluiria a diferença entre produtos diferentes.
  var BLOCO = 16, ALTURA_QR = 160;
  function assinatura(c) {
    var alt = Math.min(c.h, ALTURA_QR);
    var bw = Math.ceil(c.w / BLOCO), bh = Math.ceil(alt / BLOCO), s = new Float32Array(bw * bh);
    for (var y = 0; y < alt; y++) for (var x = 0; x < c.w; x++) {
      if (pixel(c, x, y)) s[((y / BLOCO) | 0) * bw + ((x / BLOCO) | 0)] += 1;
    }
    for (var i = 0; i < s.length; i++) s[i] /= BLOCO * BLOCO;
    return { s: s, bw: bw, bh: bh };
  }
  function distancia(a, b) {
    if (Math.abs(a.bw - b.bw) > 1 || Math.abs(a.bh - b.bh) > 1) return 1;
    var w = Math.min(a.bw, b.bw), h = Math.min(a.bh, b.bh), t = 0;
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) t += Math.abs(a.s[y * a.bw + x] - b.s[y * b.bw + x]);
    return t / (w * h);
  }
  var LIMITE_IGUAL = 0.05;
  // Agrupa células parecidas; devolve, para cada célula, o índice do grupo e a célula representante.
  function agruparCelulas(celulas) {
    var reps = [], sigs = [], idx = new Array(celulas.length), ultimo = -1, intra = 0, inter = 1;
    celulas.forEach(function (c, i) {
      var sg = assinatura(c), achou = -1, melhorD = 1;
      if (ultimo >= 0) { var d0 = distancia(sg, sigs[ultimo]); if (d0 < LIMITE_IGUAL) { achou = ultimo; melhorD = d0; } }
      if (achou < 0) {
        for (var k = 0; k < sigs.length; k++) {
          var d = distancia(sg, sigs[k]);
          if (d < melhorD) { melhorD = d; if (d < LIMITE_IGUAL) { achou = k; break; } }
          if (d < inter) inter = d;
        }
      }
      if (achou < 0) { reps.push(c); sigs.push(sg); achou = reps.length - 1; }
      else if (melhorD > intra) intra = melhorD;
      idx[i] = achou; ultimo = achou;
    });
    return { grupo: idx, reps: reps, diag: { intraMax: intra, interMin: inter } };
  }
  function paraHex(u) {
    var t = '0123456789ABCDEF', s = '';
    for (var i = 0; i < u.length; i++) s += t[u[i] >> 4] + t[u[i] & 15];
    return s;
  }

  // Monta o ZPL de saída: cada etiqueta (1 ou 2 mini-etiquetas lado a lado) vira uma imagem do tamanho da
  // bobina, baixada uma vez por sequência igual e impressa com ^PQ (mesmo mecanismo do arquivo oficial).
  function montarZpl(celulas, opts) {
    var dpm = opts.dpi === 300 ? 11.81 : 8.0;                   // pontos por mm
    var W = Math.round(opts.wMm * dpm), H = Math.round(opts.hMm * dpm);
    var cols = opts.colunas === 2 ? 2 : 1, gapPx = cols === 2 ? Math.round(FOLGA_MM * dpm) : 0;
    var LW = cols * W + (cols - 1) * gapPx, nbL = Math.ceil(LW / 8);
    var nativo = opts.dpi === 300 ? 300 / 203 : 1;                // as folhas oficiais são de 203 dpi
    var menorFator = 99;
    var cache = new Map();                                       // cada desenho é reamostrado uma única vez
    function ajustada(c) {
      if (cache.has(c)) return cache.get(c);
      var fit = Math.min((W - 2) / c.w, (H - 2) / c.h), r, fator;
      if (fit >= nativo) {
        fator = fit >= 2 * nativo ? Math.floor(fit / nativo) * nativo : nativo;
        r = escalar(c, fator);
      } else if (fit >= 1) {
        fator = fit;                               // 300 dpi: ainda é ampliação, só não chega ao tamanho físico original
        r = escalar(c, fator);
      } else {
        var parcial = encolherSoQr(c, W - 2, H - 2);
        if (parcial) { r = parcial.cel; fator = parcial.fator; }
        else { fator = fit; r = escalar(c, fator); }
      }
      if (fator < menorFator) menorFator = fator;
      cache.set(c, r);
      return r;
    }

    var rotulos = [], i;
    for (i = 0; i < celulas.length; i += cols) rotulos.push(celulas.slice(i, i + cols).map(ajustada));

    function canvas(grupo) {
      var out = new Uint8Array(nbL * H);
      grupo.forEach(function (c, k) {
        var ox = k * (W + gapPx) + Math.floor((W - c.w) / 2), oy = Math.floor((H - c.h) / 2);
        for (var y = 0; y < c.h; y++) for (var x = 0; x < c.w; x++) {
          if (c.dados[y * c.nb + (x >> 3)] & (0x80 >> (x & 7))) {
            var dx = ox + x, dy = oy + y;
            if (dx >= 0 && dx < LW && dy >= 0 && dy < H) out[dy * nbL + (dx >> 3)] |= (0x80 >> (dx & 7));
          }
        }
      });
      return out;
    }

    var blocos = [], run = null, primeira = null;
    function fecha() {
      if (!run) return;
      if (!primeira) primeira = { dados: run.dados, w: LW, h: H, nb: nbL };
      blocos.push('~DGR:OFC.GRF,' + run.dados.length + ',' + nbL + ',' + paraHex(run.dados));
      blocos.push('^XA^MMT^PON^MNY^LH0,0^PW' + LW + '^LL' + H + '^FO0,0^XGR:OFC.GRF,1,1^FS^PQ' + run.qtd + ',0,0,N^XZ');
      blocos.push('^XA^IDR:OFC.GRF^FS^XZ');
      run = null;
    }
    var ids = new Map(), proximo = 0;
    function idDe(c) { if (!ids.has(c)) ids.set(c, proximo++); return ids.get(c); }
    rotulos.forEach(function (g) {
      var k = g.map(idDe).join('|');
      if (run && run.k === k) run.qtd++;
      else { fecha(); run = { k: k, dados: canvas(g), qtd: 1 }; }
    });
    fecha();
    return { zpl: blocos.join('\n') + '\n', fator: menorFator, rotulos: rotulos.length, largura: LW, altura: H, previa: primeira };
  }

  function processarTxt(texto, opts, aoProgredir) {
    if (!/~DG/.test(texto)) {
      return Promise.reject(new Error('Este .txt não parece ser o da "Impressora Térmica" do Seller Center. Use o arquivo baixado em "Imprimir Etiqueta de Item" escolhendo Impressora Térmica.'));
    }
    return lerFolhasZpl(texto, aoProgredir).then(function (folhas) {
      if (!folhas.length) throw new Error('Não consegui ler as etiquetas deste .txt. Baixe o arquivo novamente no Seller Center.');
      var celulas = [];
      folhas.forEach(function (f) { recortarCelulas(f).forEach(function (c) { celulas.push(c); }); });
      if (!celulas.length) throw new Error('As folhas deste .txt estão vazias.');

      // etiquetas parecidas viram o mesmo produto; todas as cópias usam o desenho da primeira
      if (aoProgredir) aoProgredir('Reconhecendo os produtos…');
      return respiro().then(function () {
        var ag = agruparCelulas(celulas);
        var cont = ag.reps.map(function () { return 0; });
        ag.grupo.forEach(function (g) { cont[g]++; });
        var finais = ag.grupo.map(function (g) { return ag.reps[g]; });
        var r = montarZpl(finais, opts);
        return {
          tipo: 'zpl', zpl: r.zpl,
          etiquetas: celulas.length, produtos: ag.reps.length, semCodigo: 0,
          fator: r.fator, folhas: folhas.length, diag: ag.diag, previaBitmap: r.previa,
          lista: cont.map(function (q, n) { return { sku: 'Produto ' + (n + 1), titulo: '(etiqueta em imagem)', qtd: q }; })
        };
      });
    });
  }

  root.EtiquetasFull = { processarPdf: processarPdf, processarTxt: processarTxt };
})(typeof module !== 'undefined' && module.exports ? module.exports : window);
