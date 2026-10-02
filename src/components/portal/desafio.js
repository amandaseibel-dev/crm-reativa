// C1 -- regras puras do Desafio da semana.

// Lista fechada, igual ao CHECK da tabela. INFORMATIVO nao tem meta: e assim que
// se evita barra de progresso fingindo medir algo.
export const INDICADORES = [
  { valor: "INFORMATIVO", rotulo: "Sem medição (informativo)", mensuravel: false },
  { valor: "ELOGIOS_PUBLICADOS", rotulo: "Elogios publicados no período", mensuravel: true },
  { valor: "ELOGIOS_REGISTRADOS", rotulo: "Elogios registrados no período", mensuravel: true },
  { valor: "IDEIAS_ENVIADAS", rotulo: "Ideias enviadas no período", mensuravel: true },
  { valor: "MUSICAS_ADICIONADAS", rotulo: "Músicas adicionadas no período", mensuravel: true },
  { valor: "CURTIDAS_DADAS", rotulo: "Curtidas dadas no período", mensuravel: true },
];

export const ehMensuravel = (indicador) =>
  INDICADORES.find((i) => i.valor === indicador)?.mensuravel === true;

export const rotuloIndicador = (indicador) =>
  INDICADORES.find((i) => i.valor === indicador)?.rotulo ?? "Sem medição";

// Mostra barra so quando ha meta E progresso apurado. Progresso nulo (desafio
// informativo) nao vira zero.
export function temProgresso(desafio) {
  return !!desafio
    && desafio.meta != null
    && desafio.progresso != null
    && ehMensuravel(desafio.indicador);
}

export function percentual(desafio) {
  if (!temProgresso(desafio)) return null;
  const meta = Number(desafio.meta);
  if (!(meta > 0)) return null;
  return Math.max(0, Math.min(100, Math.round((Number(desafio.progresso) / meta) * 100)));
}

export const cumprido = (desafio) =>
  temProgresso(desafio) && Number(desafio.progresso) >= Number(desafio.meta);

export function periodoLegivel(inicio, fim) {
  const f = (v) => {
    if (!v) return "";
    const [, m, d] = String(v).slice(0, 10).split("-");
    return `${d}/${m}`;
  };
  const de = f(inicio);
  const ate = f(fim);
  if (!de && !ate) return "";
  return de === ate ? de : `${de} a ${ate}`;
}

// Valida antes de enviar. O banco tem as mesmas regras em CHECK -- aqui e so para
// a pessoa nao levar erro cru na cara.
export function validarDesafio({ titulo, indicador, meta, inicio_em, fim_em }) {
  if (!String(titulo || "").trim() || String(titulo).trim().length < 3) {
    return "Informe um título com pelo menos 3 caracteres.";
  }
  if (!inicio_em || !fim_em) return "Informe o período do desafio.";
  if (fim_em < inicio_em) return "O fim do período não pode ser antes do início.";
  if (ehMensuravel(indicador)) {
    if (!(Number(meta) > 0)) return "Indicador mensurável precisa de uma meta maior que zero.";
  } else if (meta !== "" && meta != null) {
    return "Desafio informativo não tem meta.";
  }
  return null;
}
