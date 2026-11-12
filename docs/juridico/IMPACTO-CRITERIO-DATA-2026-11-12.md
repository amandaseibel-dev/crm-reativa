# Impacto do critério de data do sinal de pagamento não baixado

Somente leitura em produção, 12/11/2026. Nenhuma regra foi alterada. Aguarda decisão da gestão.
Consultas: `docs/juridico/consultas-achado2-criterio-data-2026-11-12.sql`.

## As duas regras

- **A — atual do Jurídico** (`_juridico_pagamento_nao_baixado`, sinal c): último registro do extrato
  Prime por boleto+CPF, título ABERTO, `liquidado_em > vencimento + 30` e `liquidado_em >= created_at::date`.
  A mesma regra de data das Ações Massivas (`20260908180000_acoes_massivas_exclui_liquidados_no_prime.sql:65`).
- **C — canônica da conciliação Prime** (Grupo A, `20260918150000_grupo_a_confirmacao_prime.sql:1106`
  e `20261009180000_confirmacao_exige_pagamento_comprovado.sql:209`): A **mais** `liquidado_em <> dia da
  importação`, `liquidado_em <= data da coleta` e `liquidado_em <= hoje`. A fonte documentada diz
  "venc.+30, ≠ dia da importação" (`docs/integracoes/prime-api.md`, linha de mensalidade liquidada).

## Quantidade e valores

| Medida | A (atual) | C (canônica) |
|---|---|---|
| Alunos com título aberto e liquidação pelo critério | 564 | 517 |
| Títulos | 970 | 909 |
| Valor original dos títulos | R$ 2.252.157,46 | R$ 2.125.925,76 |

Diferença A − C: **47 alunos**, **61 títulos**, **R$ 126.231,70**. (57 alunos têm liquidação no dia da
importação; 10 deles têm outra liquidação válida e continuam barrados por C.)

**Universo do Jurídico hoje (2.640 alunos):** nenhum aluno muda de elegibilidade entre A e C. Os 24
barrados por este sinal são os mesmos nas duas regras. Por isso, a decisão afeta lotes **futuros**
e a base geral, não o lote atual.

## Casos em que o pagamento pode ser lido errado

1. **Artefato na importação.** Liquidação no mesmo dia em que o título foi importado no CRM
   (`liquidado_em = created_at::date`): 57 alunos, 61 títulos. A regra A trata como pagamento; a
   canônica não. Exemplo mascarado: aluno `45785e23`, boletos `4719` e `4720`, vencidos em 2025,
   importados e "liquidados" em 02/07/2026, coleta em 07/11/2026, R$ 1.580,04 pago.
2. **Liquidação após a coleta ou no futuro:** 0 casos hoje (a guarda da canônica não bloqueia nada agora).
3. **Mesmo critério nas Ações Massivas:** a massiva também lê o artefato como pagamento e pode excluir
   esses alunos das ações. Não foi medido aqui; é uma decisão separada da gestão.

## Recomendação

Adotar a regra C no Jurídico (e avaliar o mesmo ajuste nas Ações Massivas), porque é a regra canônica
documentada e documentada como "não é artefato". Antes, a gestão precisa confirmar:
(a) se o artefato da importação deve mesmo ser descartado; (b) se a mudança vale para a base geral.
Não alterar sem aprovação da gestão.
