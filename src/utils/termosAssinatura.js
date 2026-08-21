// Trilha de assinatura de testemunhas + Ulbra dos termos de acordo.
// ---------------------------------------------------------------------------
// Vive em `etapa_assinatura`, separada de `status` (que move a fila de
// validação e as notificações ao operador). Termo carregado de um banco sem a
// coluna cai em NAO_APLICAVEL, e a aba Assinaturas fica vazia em vez de quebrar.
export const ETAPA_LABEL = {
  NAO_APLICAVEL: "Sem assinatura pendente",
  NAO_VERIFICADO: "Não verificado",
  PENDENTE_ENVIO: "A enviar",
  ENVIADO_ASSINATURA: "Aguardando assinaturas",
  COMPLETO: "Termo assinado",
};

export const ETAPAS_ASSINATURA = [
  "NAO_VERIFICADO",
  "PENDENTE_ENVIO",
  "ENVIADO_ASSINATURA",
  "COMPLETO",
];

export function etapaDe(t) {
  const e = t?.etapa_assinatura;
  return ETAPA_LABEL[e] ? e : "NAO_APLICAVEL";
}

// Data que ORDENA cada termo na aba Assinaturas: a da própria etapa em que ele
// está. "Mais recentes primeiro" num termo assinado é a data da assinatura; num
// que está fora, a data em que saiu; nos que ninguém tocou, a da liberação.
// Ordenar tudo pela mesma data faria a lista mentir em duas das três etapas.
export function dataEtapa(t) {
  const etapa = etapaDe(t);
  const bruto =
    etapa === "COMPLETO"
      ? t?.assinatura_completa_em || t?.validado_em || t?.criado_em
      : etapa === "ENVIADO_ASSINATURA"
        ? t?.assinatura_enviada_em || t?.validado_em || t?.criado_em
        : t?.validado_em || t?.criado_em;
  const ms = bruto ? new Date(bruto).getTime() : NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

// Busca por aluno: nome sem depender de acento/maiúscula, ou CPF por dígitos
// (a ADM digita com ponto e traço; o aluno pode estar gravado sem). Só compara;
// nunca expõe o CPF inteiro — a tela segue mostrando o parcial.
export function normalizarBusca(texto) {
  return String(texto ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

export function casaBusca(termo, busca) {
  const alvo = normalizarBusca(busca);
  if (!alvo) return true;

  const nome = normalizarBusca(termo?.aluno_nome);
  if (nome.includes(alvo)) return true;

  // 3 dígitos é o mínimo para não casar CPF por acidente ao digitar um nome.
  const digitos = alvo.replace(/\D/g, "");
  if (digitos.length >= 3) {
    const cpf = String(termo?.aluno_cpf ?? "").replace(/\D/g, "");
    if (cpf && cpf.includes(digitos)) return true;
  }
  return false;
}
