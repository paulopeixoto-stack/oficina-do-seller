/* Conversor de regras tributárias: Mercado Livre -> Shopee.
   Roda inteiramente no navegador. Nenhum dado sai do computador do usuário. */
(function (root) {
  'use strict';

  var DATA_START = 6;

  function norm(s) {
    return String(s == null ? '' : s)
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ').trim().replace(/[:\s]+$/, '').toLowerCase();
  }

  function colIdx(letters) {
    var n = 0;
    for (var i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
    return n;
  }

  function unescapeXml(s) {
    return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(+d); })
      .replace(/&amp;/g, '&');
  }

  function escapeXml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function readSharedStrings(xml) {
    if (!xml) return [];
    var out = [], siRe = /<si>([\s\S]*?)<\/si>/g, m;
    while ((m = siRe.exec(xml))) {
      var parts = [], tRe = /<t[^>]*>([\s\S]*?)<\/t>/g, t;
      while ((t = tRe.exec(m[1]))) parts.push(unescapeXml(t[1]));
      out.push(parts.join(''));
    }
    return out;
  }

  var CELL_RE = /<c r="([A-Z]+)(\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  var ROW_RE = /<row r="(\d+)"[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g;

  function readSheet(xml, shared) {
    var rows = {}, rm;
    ROW_RE.lastIndex = 0;
    while ((rm = ROW_RE.exec(xml))) {
      var cells = {}, body = rm[2] || '', cm;
      CELL_RE.lastIndex = 0;
      while ((cm = CELL_RE.exec(body))) {
        var type = /t="([^"]+)"/.exec(cm[3]);
        type = type ? type[1] : 'n';
        var inner = cm[4] || '', val = '';
        var v = /<v>([\s\S]*?)<\/v>/.exec(inner);
        if (type === 's' && v) val = shared[+v[1]] || '';
        else if (type === 'inlineStr') {
          var parts = [], tRe = /<t[^>]*>([\s\S]*?)<\/t>/g, t;
          while ((t = tRe.exec(inner))) parts.push(unescapeXml(t[1]));
          val = parts.join('');
        } else if (v) val = unescapeXml(v[1]);
        cells[colIdx(cm[1])] = val;
      }
      rows[+rm[1]] = cells;
    }
    return rows;
  }

  function sheetPathByName(workbookXml, relsXml, wantedName) {
    var rels = {}, rm, rRe = /<Relationship([^>]*)\/>/g;
    while ((rm = rRe.exec(relsXml))) {
      var id = /Id="([^"]+)"/.exec(rm[1]), tg = /Target="([^"]+)"/.exec(rm[1]);
      if (id && tg) rels[id[1]] = tg[1];
    }
    var sRe = /<sheet([^>]*)\/>/g, sm;
    while ((sm = sRe.exec(workbookXml))) {
      var nm = /name="([^"]*)"/.exec(sm[1]);
      var rid = /r:id="([^"]+)"/.exec(sm[1]);
      if (nm && rid && norm(unescapeXml(nm[1])) === norm(wantedName)) {
        var t = rels[rid[1]].replace(/^\//, '');
        return t.indexOf('xl/') === 0 ? t : 'xl/' + t;
      }
    }
    return null;
  }

  // ---- tabelas de conversão (idênticas às do conversor oficial da Shopee) ----
  var IPI_FLIP = {
    '50 - Saída Tributada': '00 - Entrada com recuperação de crédito',
    '51 - Saída Tributável com Alíquota Zero': '01 - Entrada tributada com alíquota zero',
    '52 - Saída Isenta': '02 - Entrada isenta',
    '53 - Saída Não Tributada': '03 - Entrada não-tributada',
    '54 - Saída Imune': '04 - Entrada imune',
    '55 - Saída com Suspensão': '05 - Entrada com suspensão'
  };
  var PISCOFINS_SAIDA = [
    '01 - Operação Tributável com Alíquota Básica',
    '02 - Operação Tributável com Alíquota Diferenciada',
    '04 - Operação Tributável Monofásica - Revenda a Alíquota Zero',
    '06 - Operação Tributável a Alíquota Zero',
    '07 - Operação Isenta da Contribuição',
    '08 - Operação sem Incidência da Contribuição',
    '09 - Operação com Suspensão da Contribuição',
    '49 - Outras Operações de Saída',
    '99 - Outras Operações'
  ];
  var PISCOFINS_ENTRADA = '98 - Outras Operações de Entrada';
  var SKIP = ['nao aplicavel', 'calculada automaticamente', ''];

  var OPS = [
    { src: 'Não contribuinte', fallback: 'Contribuinte (consumo)', entrada: false, same: 'PREENCHER', diff: 'PREENCHER' },
    { src: 'Envio de estoque (Transferência ou Remessa)', entrada: false, same: '5949', diff: '6949' },
    { src: 'Envio de estoque (Transferência ou Remessa)', entrada: true, same: '1949', diff: '2949' },
    { src: 'Não contribuinte', fallback: 'Contribuinte (consumo)', entrada: true, same: '1949', diff: '2949' }
  ];
  var GLOBAL_FIELDS = [
    ['IPI_ST', 'Situação Tributária do IPI', 'ipi'],
    ['IPI_ALIQUOTA', 'Alíquota de IPI (%)', 'num'],
    ['IPI_COD_ENQ', 'Código Enquadramento legal IPI', 'copy'],
    ['PIS_ST', 'Situação Tributária do PIS', 'pc'],
    ['PIS_ALIQUOTA', 'Alíquota de PIS (%)', 'num'],
    ['COFINS_ST', 'Situação Tributária do COFINS', 'pc'],
    ['COFINS_ALIQUOTA', 'Alíquota de COFINS (%)', 'num']
  ];
  var STATE_FIELDS = [
    ['CST', 'Situação Tributária CST Regime Normal'],
    ['PICMS_INTERNAL', 'Alíquota de ICMS interna UF destino (%)'],
    ['PICMS_INTERSTATE', 'Aliquota de ICMS interestadual (%)'],
    ['REDUCTION_CALC_BASE', 'Redução da Base de Cálculo (%)'],
    ['REDUCTION_CALC_BASE_ST', 'Redução da Base de Cálculo ST (%)'],
    ['REDUCTION_CALC_DIFAL', 'Redução da Base de Cálculo do DIFAL (%)'],
    ['PICMS_FCP', 'Alíquota FCP Destino (%)'],
    ['PICMS_EFET', 'Alíquota do ICMS Efetivo(%)'],
    ['PREDB_CEFET', 'Percentual de redução da base de cálculo do ICMS Efetivo(%)'],
    ['MVA', 'MVA (Ajustado) (%)'],
    ['COD_BENEF', 'Código de benefício fiscal na UF'],
    ['MOT_DES_ICMS', 'Motivo de desoneração']
  ];

  function num2(v) {
    var s = String(v).trim();
    if (s === '') return '';
    if (s.indexOf(',') >= 0) return s;
    var f = parseFloat(s);
    return isNaN(f) ? s : f.toFixed(2).replace('.', ',');
  }
  function clean(v) {
    return SKIP.indexOf(norm(v)) >= 0 ? '' : String(v == null ? '' : v);
  }

  function readML(rows) {
    var KEYS = ['RULE_ID', 'RULE_NAME', 'ORIGIN', 'TRANSACTION_TYPE'];
    var hdr = null, best = -1;
    Object.keys(rows).map(Number).sort(function (a, b) { return a - b; }).slice(0, 25).forEach(function (r) {
      var score = 0;
      for (var c in rows[r]) if (KEYS.indexOf(String(rows[r][c]).trim()) >= 0) score++;
      if (score > best) { best = score; hdr = r; }
    });
    if (best < KEYS.length) {
      throw new Error('Não encontrei a linha de códigos técnicos na planilha do Mercado Livre. ' +
        'Confira se o arquivo é a exportação de Regras Tributárias, sem alterações.');
    }
    var code2col = {};
    for (var c2 in rows[hdr]) {
      var code = String(rows[hdr][c2]).trim();
      if (code) code2col[code] = +c2;
    }
    KEYS.forEach(function (k) {
      if (!(k in code2col)) throw new Error('A coluna ' + k + ' não existe na planilha do Mercado Livre.');
    });

    var rules = [], seen = {};
    Object.keys(rows).map(Number).sort(function (a, b) { return a - b; }).forEach(function (r) {
      if (r < hdr + 2) return;
      var row = rows[r];
      var rid = String(row[code2col.RULE_ID] || '').trim();
      if (!rid) return;
      var origin = String(row[code2col.ORIGIN] || '').trim();
      var key = rid + '||' + origin;
      if (!(key in seen)) {
        seen[key] = rules.length;
        rules.push({ ruleId: rid, origin: origin, name: row[code2col.RULE_NAME] || '', tx: {} });
      }
      rules[seen[key]].tx[norm(row[code2col.TRANSACTION_TYPE])] = row;
    });

    // A Shopee recusa duas regras com o mesmo nome. Quando o ML repete a regra
    // em várias origens, fica o bloco que realmente tem alíquotas.
    function weight(rule) {
      var n = 0;
      Object.keys(rule.tx).forEach(function (k) {
        var row = rule.tx[k];
        Object.keys(code2col).forEach(function (code) {
          if (code.indexOf('ICMS_') !== 0) return;
          var v = String(row[code2col[code]] || '').trim().replace(',', '.');
          var f = parseFloat(v);
          if (!isNaN(f)) { if (f !== 0) n++; } else if (v) n++;
        });
      });
      return n;
    }
    var best2 = {}, dropped = 0;
    rules.forEach(function (rule) {
      var k = norm(rule.name);
      if (!(k in best2)) { best2[k] = rule; return; }
      dropped++;
      if (weight(rule) > weight(best2[k])) best2[k] = rule;
    });
    var kept = rules.filter(function (r) {
      return Object.keys(best2).some(function (k) { return best2[k] === r; });
    });
    return { rules: kept, code2col: code2col, dropped: dropped };
  }

  function shopeeColumns(rows) {
    var groups = [];
    Object.keys(rows[1] || {}).map(Number).sort(function (a, b) { return a - b; }).forEach(function (c) {
      var v = String(rows[1][c] || '').trim();
      if (v) groups.push([c, v]);
    });
    function groupOf(col) {
      var g = '';
      for (var i = 0; i < groups.length; i++) {
        if (groups[i][0] <= col) g = groups[i][1]; else break;
      }
      return g;
    }
    var glob = {}, states = {};
    Object.keys(rows[2] || {}).map(Number).forEach(function (c) {
      var lbl = String(rows[2][c] || '').trim();
      if (!lbl) return;
      var m = /\(([A-Z]{2})\)\s*$/.exec(groupOf(c));
      if (m) {
        if (!states[m[1]]) states[m[1]] = {};
        if (!(norm(lbl) in states[m[1]])) states[m[1]][norm(lbl)] = c;
      } else if (!(norm(lbl) in glob)) glob[norm(lbl)] = c;
    });
    return { glob: glob, states: states };
  }

  function convert(mlZip, tplZip, JSZipRef) {
    return Promise.all([
      mlZip.file('xl/workbook.xml').async('string'),
      mlZip.file('xl/_rels/workbook.xml.rels').async('string'),
      mlZip.file('xl/sharedStrings.xml') ? mlZip.file('xl/sharedStrings.xml').async('string') : Promise.resolve(''),
      tplZip.file('xl/workbook.xml').async('string'),
      tplZip.file('xl/_rels/workbook.xml.rels').async('string'),
      tplZip.file('xl/sharedStrings.xml') ? tplZip.file('xl/sharedStrings.xml').async('string') : Promise.resolve('')
    ]).then(function (a) {
      var mlPath = sheetPathByName(a[0], a[1], 'Regras Tributárias');
      if (!mlPath) throw new Error('Não encontrei a aba "Regras Tributárias" no arquivo enviado. ' +
        'Verifique se é a planilha exportada do Mercado Livre.');
      var tplPath = sheetPathByName(a[3], a[4], 'sheet1');
      if (!tplPath) throw new Error('Template da Shopee inválido: aba "sheet1" não encontrada.');
      return Promise.all([
        mlZip.file(mlPath).async('string'),
        tplZip.file(tplPath).async('string'),
        Promise.resolve(readSharedStrings(a[2])),
        Promise.resolve(readSharedStrings(a[5])),
        Promise.resolve(tplPath)
      ]);
    }).then(function (b) {
      var mlRows = readSheet(b[0], b[2]);
      var tplRows = readSheet(b[1], b[3]);
      var tplPath = b[4];

      var ml = readML(mlRows);
      var cols = shopeeColumns(tplRows);
      var nStates = Object.keys(cols.states).length;
      if (nStates !== 27) throw new Error('Template da Shopee inesperado: encontrei ' + nStates + ' blocos de estado em vez de 27.');

      var rowNums = Object.keys(tplRows).map(Number).filter(function (r) { return r >= DATA_START; });
      var LAST_ROW = Math.max.apply(null, rowNums);
      var capacity = Math.floor((LAST_ROW - DATA_START + 1) / 4);
      if (ml.rules.length > capacity) {
        throw new Error('A planilha tem ' + ml.rules.length + ' regras, e o template da Shopee comporta ' + capacity + '.');
      }

      var values = {}, row = DATA_START;
      ml.rules.forEach(function (rule) {
        OPS.forEach(function (op) {
          var src = rule.tx[norm(op.src)] || (op.fallback ? rule.tx[norm(op.fallback)] : null);
          if (!src) { row++; return; }
          function put(col, val) { if (col) values[row + ':' + col] = val; }

          put(cols.glob[norm('Nome da regra')], rule.name);
          put(cols.glob[norm('CFOP Mesmo Estado')], op.same);
          put(cols.glob[norm('CFOP Estados diferentes')], op.diff);

          GLOBAL_FIELDS.forEach(function (f) {
            var raw = clean(src[ml.code2col[f[0]]]);
            var val = raw;
            if (f[2] === 'num') val = num2(raw);
            else if (f[2] === 'ipi' && op.entrada) val = IPI_FLIP[raw] || raw;
            else if (f[2] === 'pc' && op.entrada && PISCOFINS_SAIDA.indexOf(raw) >= 0) val = PISCOFINS_ENTRADA;
            put(cols.glob[norm(f[1])], val);
          });

          Object.keys(cols.states).forEach(function (uf) {
            STATE_FIELDS.forEach(function (f) {
              put(cols.states[uf][norm(f[1])], clean(src[ml.code2col['ICMS_' + uf + '_' + f[0]]]));
            });
          });
          row++;
        });
      });

      var parts = /^([\s\S]*?<sheetData>)([\s\S]*)(<\/sheetData>[\s\S]*)$/.exec(b[1]);
      if (!parts) throw new Error('Template da Shopee inválido: bloco de dados não encontrado.');

      var patched = parts[2].replace(ROW_RE, function (whole, rn, body) {
        var r = +rn;
        if (r < DATA_START || body == null) return whole;
        var newBody = body.replace(CELL_RE, function (cell, letters, digits, attrs) {
          var ci = colIdx(letters), key = r + ':' + ci, v;
          if (key in values) v = values[key];
          else if (ci === 4 || ci === 7) return cell;  // "Tipo de operação" já vem no template
          else v = '';
          var st = /\ss="(\d+)"/.exec(attrs);
          var s = st ? ' s="' + st[1] + '"' : '';
          var ref = letters + digits;
          if (v === '') return '<c r="' + ref + '"' + s + '/>';
          return '<c r="' + ref + '"' + s + ' t="inlineStr"><is><t xml:space="preserve">' + escapeXml(v) + '</t></is></c>';
        });
        return whole.replace(body, newBody);
      });

      var out = parts[1] + patched + parts[3];

      // Falha do template: as validações cobrem 7..2000, mas os dados vivem em 6..2005.
      function fixRanges(sq) {
        return sq.replace(/([A-Z]{1,2})7:([A-Z]{1,2})2000/g, function (_, a, c) {
          return a + DATA_START + ':' + c + LAST_ROW;
        });
      }
      out = out.replace(/(<xm:sqref>)([\s\S]*?)(<\/xm:sqref>)/g, function (_, a, sq, c) { return a + fixRanges(sq) + c; });
      out = out.replace(/(sqref=")([^"]*)(")/g, function (_, a, sq, c) { return a + fixRanges(sq) + c; });

      var zip = new JSZipRef();
      var names = [];
      tplZip.forEach(function (path, entry) { if (!entry.dir) names.push(path); });
      return Promise.all(names.map(function (p) {
        return p === tplPath ? Promise.resolve(out) : tplZip.file(p).async('uint8array');
      })).then(function (datas) {
        names.forEach(function (p, i) { zip.file(p, datas[i], { createFolders: false }); });
        return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }).then(function (bytes) {
          return { bytes: bytes, rules: ml.rules.length, rows: row - DATA_START, dropped: ml.dropped, capacity: capacity };
        });
      });
    });
  }

  root.MLShopee = { convert: convert, norm: norm };
})(typeof module !== 'undefined' && module.exports ? module.exports : window);
