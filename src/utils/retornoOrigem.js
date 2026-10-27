// ORIGEM DO RETORNO -- um só jeito de perguntar "isto é combinado do operador?".
//
// `alunos.retorno_origem` é texto livre. Três valores em uso: 'OPERADOR',
// 'OPERADOR_EM_CONFIRMACAO' (posto pelo gatilho da fila de confirmação) e
// 'AUTOMATICO'. Por isso a comparação é por PREFIXO, nunca por igualdade.
//
// O BANCO TEM DUAS FORMAS, e isto importa -- a versão anterior deste cabeçalho
// dizia que o banco "pergunta sempre do mesmo jeito", e era falso. As duas
// estão nas migrations do repositório E no corpo VIVO da função em produção: em
// 27/10/2026 li `pg_get_functiondef('recalcular_situacao_aluno')` em
// `ahattpqrjmhkzsmnbdzs` e o ramo ACORDO_EM_DIA traz a forma ESTRITA (sem
// `upper`) na linha 198 da definição vigente. Não é só dívida de repositório:
//
//   * TOLERANTE, normaliza a caixa --
//     `supabase/migrations/20261019132433_acao_massiva_tabula_com_retorno_10_dias.sql`
//     (linhas 159, 164, 222, 227): `upper(coalesce(a.retorno_origem,''))
//     like 'OPERADOR%'`;
//   * ESTRITA, sem `upper` -- `recalcular_situacao_aluno`, ramo ACORDO_EM_DIA:
//     `coalesce(v_orig_atual,'') like 'OPERADOR%'`, em
//     `20260919160000_prime_conferencia_encerramento_administrativo.sql:668`
//     e idêntica em `20260822120000`, `20260914100000` e `20260918150000`.
//
// ESTE MÓDULO SEGUE A TOLERANTE, de propósito, porque os dois erros possíveis
// não têm o mesmo preço: um falso positivo PRESERVA uma data que talvez não
// fosse compromisso; um falso negativo APAGA um compromisso que era real. Entre
// os dois, preservar. Consequência a ter em mente: para uma origem fora de
// caixa alta, a tela preservaria o compromisso e o ramo ACORDO_EM_DIA do motor
// o sobrescreveria -- a divergência é do banco, não daqui, e alinhar as duas
// formas do SQL é trabalho de migration, que esta frente não tem autorização
// para fazer.
//
// MEDIDO EM PRODUÇÃO (27/10/2026, `ahattpqrjmhkzsmnbdzs`), só leitura: a coluna
// tem exatamente três valores -- 'AUTOMATICO' 12.876, nulo 5.069, 'OPERADOR'
// 490 --, e ZERO linhas fora de caixa alta, ZERO com espaço nas pontas. Ou
// seja: hoje a diferença entre a forma tolerante e a estrita não muda a
// resposta para nenhuma ficha. A normalização é defesa contra dado futuro, não
// correção de um problema em curso.
//
// Antes disto o frontend tinha QUATRO leituras próprias, todas com
// `startsWith("OPERADOR")` cru: sensível a caixa e sem aparar espaço. É a
// Premissa 12 (`docs/PREMISSAS.md`, "A regra mora no banco, não na tela") que
// manda não ter duas contas para a mesma pergunta.
//
// Este módulo é PURO de propósito: não importa `supabase` nem nada do projeto.
// Isso é o que permite que `utils/painelMeuDia.js`, que promete não falar com o
// banco, use a mesma função que `utils/tabulacoes.js`, que fala.

export const PREFIXO_OPERADOR = "OPERADOR";

// Texto da origem como o SQL tolerante o compara: sem espaço nas pontas, em
// caixa alta. `null`/`undefined` viram "", como o `coalesce(...,'')`.
export function normalizarOrigemRetorno(origem) {
  return String(origem ?? "").trim().toUpperCase();
}

// Equivalente a `upper(coalesce(origem,'')) like 'OPERADOR%'`. Cobre
// 'OPERADOR' e 'OPERADOR_EM_CONFIRMACAO' -- os dois são compromisso de uma
// pessoa, e é por isso que a comparação é por PREFIXO e não por igualdade.
export function ehOrigemDoOperador(origem) {
  return normalizarOrigemRetorno(origem).startsWith(PREFIXO_OPERADOR);
}
