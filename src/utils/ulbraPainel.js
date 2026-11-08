// Formatação e leitura de estado do Painel Gestão da Mensageria — sem React.
// Separado da página para o fast refresh (regra react-refresh/only-export-
// components) e para ser testado sem DOM.
//
// Regra única destas funções: dado ausente vira "não disponível". Nunca zero,
// nunca estimativa.

export const ND = "não disponível";

export function fmtHora(iso) {
  if (!iso) return ND;
  try {
    return new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch {
    return ND;
  }
}

export function fmtMin(v) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return ND;
  const m = Math.round(Number(v));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${String(m % 60).padStart(2, "0")} min`;
}

export function fmtNum(v) {
  return v === null || v === undefined ? ND : String(v);
}

/**
 * Texto e cor do bloco de estado. Os cinco estados são DIFERENTES de propósito:
 * zero de verdade (EM_DIA sem nada), sem ciclo, desatualizado, erro e coleta
 * incompleta não podem ser lidos como a mesma coisa.
 */
export function descreverEstado(d) {
  const s = d?.sync || {};
  const atraso = fmtMin(s.atraso_min);
  switch (d?.estado) {
    case "SEM_CICLO":
      return { tom: "cinza", titulo: "Nenhum ciclo de sincronização executado ainda",
        texto: "Os números abaixo são zero porque nada foi coletado — não porque não haja nada na Mensageria." };
    case "ERRO":
      return { tom: "vermelho", titulo: `Último ciclo FALHOU há ${atraso}`,
        texto: `Erro: ${s.ultimo_erro || ND}. A janela não avançou; os números são do último ciclo que deu certo.` };
    case "DESATUALIZADO":
      return { tom: "vermelho", titulo: `Dados desatualizados: ${atraso} sem sincronizar`,
        texto: "A sincronização automática está atrasada. Zero aqui NÃO significa que não há nada." };
    case "INCOMPLETO":
      return { tom: "ambar", titulo: `Coleta incompleta há ${atraso}`,
        texto: `Motivo: ${s.ultimo_erro || ND}. O cursor não avançou e o piso ficou guardado${s.piso_pendente ? ` (${fmtHora(s.piso_pendente)})` : ""}. O próximo ciclo continua dali — nada foi descartado.` };
    case "EM_DIA":
      return { tom: "verde", titulo: `Último ciclo OK há ${atraso}`, texto: "" };
    default:
      return { tom: "cinza", titulo: ND, texto: "" };
  }
}
