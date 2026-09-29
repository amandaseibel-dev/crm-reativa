// Leitura da resposta de `students_search`, isolada do Deno para poder ser
// testada. `index.ts` não é testável pelo vitest (Deno.serve, Deno.env, import
// remoto), e a classificação dos desfechos é justamente a parte que não pode
// estar errada.

const digitos = (v: unknown) => String(v ?? "").replace(/\D/g, "");

// O `search` SÓ ENCONTRA CPF FORMATADO. Em dígitos puros a API devolve
// `totalItems: 0` sem nenhum sinal de erro -- falha silenciosa, documentada em
// docs/integracoes/prime-api.md. Mandar sem pontuação produziria "aluno não
// encontrado" para gente que está lá.
export function formatarCpf(bruto: unknown): string | null {
  const d = digitos(bruto);
  if (d.length !== 11) return null;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

export type Resultado = "COM_VINCULOS" | "SEM_RESULTADO" | "FALHA_COMUNICACAO";

// TRÊS DESFECHOS DISTINTOS, e a distinção é o ponto desta função:
//
//   FALHA_COMUNICACAO  não se sabe nada (4xx/5xx/timeout/JSON ilegível)
//   SEM_RESULTADO      a API respondeu, e não achou o CPF naquela busca
//   COM_VINCULOS       a API respondeu e trouxe linhas
//
// "Sem resultado" NÃO é "não tem vínculo": o `search` é substring e pode não
// achar. E falha de rede não é nenhum dos dois -- se virasse "sem resultado", a
// tela diria que o aluno não tem vínculo por causa de um timeout.
export function resultadoDaResposta(
  dados: unknown,
  falha: string | null,
): { resultado: Resultado; totalItems: number | null; registration: string | null } {
  if (falha) return { resultado: "FALHA_COMUNICACAO", totalItems: null, registration: null };

  const d = dados as { items?: unknown; totalItems?: unknown } | null;
  const itens = Array.isArray(d?.items) ? (d!.items as Record<string, unknown>[]) : null;

  // 200 com corpo que não tem `items` array: não se sabe o que a API disse.
  // Não é "vazio" -- é ilegível, e vai para falha.
  if (itens === null) {
    return { resultado: "FALHA_COMUNICACAO", totalItems: null, registration: null };
  }

  const total = typeof d?.totalItems === "number" ? (d!.totalItems as number) : itens.length;
  if (itens.length === 0) return { resultado: "SEM_RESULTADO", totalItems: total, registration: null };

  // `registration` é informação, não chave de vínculo. Guardado só se todas as
  // linhas concordarem -- se divergirem, fica nulo em vez de escolher uma.
  const regs = [...new Set(itens.map((i) => String(i?.registration ?? "")).filter(Boolean))];
  return {
    resultado: "COM_VINCULOS",
    totalItems: total,
    registration: regs.length === 1 ? regs[0] : null,
  };
}

// Devolve items[] NA ORDEM, filtrando por CPF exato e removendo os campos
// pessoais que este registro não precisa guardar de novo.
//
// POR QUE FILTRAR POR CPF: o `search` é substring, então pedir um CPF pode
// trazer linhas de OUTRA pessoa cujo CPF contenha o trecho. Guardar essas linhas
// colaria o vínculo de um terceiro na ficha.
//
// A ORDEM É PRESERVADA e vira a coluna `ordem` no banco: é o único
// discriminador de vínculos com curso, campus e turno idênticos -- e eles
// existem (três na matrícula 222007757, com status diferentes).
export function vinculosDaResposta(dados: unknown, cpfDaFicha: unknown): Record<string, unknown>[] {
  const d = dados as { items?: unknown } | null;
  const itens = Array.isArray(d?.items) ? (d!.items as Record<string, unknown>[]) : [];
  const alvo = digitos(cpfDaFicha);
  return itens
    .filter((i) => !alvo || digitos(i?.cpf) === alvo)
    .map((i) => ({
      course: i?.course ?? null,
      campus: i?.campus ?? null,
      shift: i?.shift ?? null,
      status: i?.status ?? null,
      admissionYear: i?.admissionYear ?? null,
      graduated: i?.graduated ?? null,
    }));
}
