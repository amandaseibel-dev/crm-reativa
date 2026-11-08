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
 * Texto e cor do bloco de estado. Os estados são DIFERENTES de propósito:
 * sem ciclo, erro, pulado por orçamento, desatualizado, coleta incompleta,
 * em dia (só com cron) e coleta concluída (manual, sempre com data e hora)
 * não podem ser lidos como a mesma coisa.
 */
export function descreverEstado(d) {
  const s = d?.sync || {};
  const atraso = fmtMin(s.atraso_min);
  const quando = fmtHora(s.ultima_execucao);
  switch (d?.estado) {
    case "SEM_CICLO":
      return { tom: "cinza", titulo: "Nenhum ciclo de sincronização executado ainda",
        texto: "Os números abaixo são zero porque nada foi coletado — não porque não haja nada na Mensageria." };
    case "ERRO":
      return { tom: "vermelho", titulo: `Último ciclo FALHOU em ${quando} (há ${atraso})`,
        texto: `Erro: ${s.ultimo_erro || ND}. A janela não avançou; os números são do último ciclo que deu certo.` };
    case "PULADO_ORCAMENTO":
      return { tom: "vermelho", titulo: `Último ciclo PULADO por orçamento em ${quando} (há ${atraso})`,
        texto: "Nada foi lido da Mensageria nesse ciclo: o saldo do dia não permitiu. Os números abaixo são do ciclo anterior — isto NÃO é atualizado." };
    case "COLETA_CONCLUIDA":
      return { tom: "verde", titulo: `Última coleta concluída em ${quando} (há ${atraso})`,
        texto: "Atualização manual: não há sincronização automática prometendo a próxima coleta. Os números valem para esse horário." };
    case "DESATUALIZADO":
      return { tom: "vermelho", titulo: `Dados desatualizados: ${atraso} sem sincronizar`,
        texto: "A sincronização automática está atrasada. Zero aqui NÃO significa que não há nada." };
    case "INCOMPLETO":
      return { tom: "ambar", titulo: `Coleta incompleta há ${atraso}`,
        texto: `Motivo: ${s.ultimo_erro || ND}. O cursor não avançou e o piso ficou guardado${s.piso_pendente ? ` (${fmtHora(s.piso_pendente)})` : ""}. O próximo ciclo continua dali — nada foi descartado.` };
    case "EM_DIA":
      return { tom: "verde", titulo: `Último ciclo OK em ${quando} (há ${atraso}) — sincronização automática em dia`, texto: "" };
    default:
      return { tom: "cinza", titulo: ND, texto: "" };
  }
}
