// ============================================================================
// ESCOPO DECLARADO DE UMA EXTRAÇÃO (J3/I2, 01/10/2026)
//
// POR QUE ESTE ARQUIVO EXISTE: a `scope_key` do Relatório de Títulos em Aberto
// estava fixa no código como `PORTADOR=195|BORDERO=TODOS|TIPO=TODOS`. Com isso,
// uma extração filtrada por tipo de boleto e uma extração completa da carteira
// caíam na MESMA sequência comparável — e a ausência derivada dali seria
// artefato do filtro, não do relatório.
//
// Duas extrações só são comparáveis quando `source_type` + `scope_key` são
// iguais. Logo, toda dimensão que muda a população esperada precisa estar na
// chave.
//
// A DECLARAÇÃO NÃO É A ÚNICA FONTE. O conteúdo do arquivo restringe o que pode
// ser declarado (`escopoTipoPermitido` aqui, na tela) e
// `extracao_lote_fechar` reconfere no banco antes de deixar a extração virar
// referência. A verificação do banco é a que vale: a daqui é conveniência e
// pode ser contornada por quem chamar a RPC direto.
// ============================================================================

// Vocabulário fechado, de propósito. Cada valor é verificável contra o conteúdo
// ou inofensivo:
//   TODOS    — extraído sem filtro de tipo. Exige 2+ tipos distintos no arquivo.
//   ACORDO   — filtrado em Acordo. Exige 100% das linhas do tipo `Acordo`.
//   RECORTE  — qualquer outro filtro de tipo. Não afirma nada sobre o conteúdo;
//              é seguro porque duas extrações RECORTE só se comparam quando o
//              CONJUNTO DE TIPOS é idêntico (verificação V2 no fechamento).
//
// Não usei o nome do tipo na chave. A base tem mojibake real
// ("Cursos de GraduaÁ„o Presencial", 1.124 títulos; "Extens„o", 4): o mesmo tipo
// gravado de dois jeitos geraria duas chaves e partiria a sequência em silêncio.
// A comparação fina é feita no banco por id de rótulo, imune a isso.
export const TIPOS_DE_ESCOPO = Object.freeze(["TODOS", "ACORDO", "RECORTE"]);

export function soAcordo(tiposNoArquivo) {
  const t = tiposNoArquivo || [];
  return t.length > 0 && t.every((x) => String(x).trim().toLowerCase() === "acordo");
}

export function temAlgumAcordo(tiposNoArquivo) {
  return (tiposNoArquivo || []).some((x) => String(x).trim().toLowerCase() === "acordo");
}

// Um valor só é permitido se o conteúdo do arquivo o sustenta.
export function escopoTipoPermitido(valor, tiposNoArquivo) {
  const t = tiposNoArquivo || [];
  if (!TIPOS_DE_ESCOPO.includes(valor)) return false;
  if (valor === "TODOS") return t.length >= 2;   // 1 tipo nunca é "sem filtro"
  if (valor === "ACORDO") return soAcordo(t);    // precisa ser 100% Acordo
  return t.length > 0;                           // RECORTE: só exige ter conteúdo
}

export function motivoDoBloqueio(valor, tiposNoArquivo) {
  const t = tiposNoArquivo || [];
  if (valor === "TODOS" && t.length < 2) {
    return `o arquivo tem ${t.length} tipo de boleto; "sem filtro" precisa de 2 ou mais`;
  }
  if (valor === "ACORDO" && !soAcordo(t)) {
    return "o arquivo tem linha de tipo diferente de Acordo";
  }
  return null;
}

export function scopeKeyRelatorio(portador, bordero, tipo) {
  const p = String(portador || "").trim();
  const b = String(bordero || "").trim() || "TODOS";
  const t = String(tipo || "").trim();
  return `PORTADOR=${p}|BORDERO=${b}|TIPO=${t}`;
}
