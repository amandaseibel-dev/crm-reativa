# Relatório de mensalidades sem negociação 2026/2: diagnóstico da contagem de alunos

Dados agregados de leitura no projeto Supabase de produção, em novembro de 2026. Nenhum CPF completo ou dado pessoal consta deste documento.

## Chave de contagem

- 2026/1 (`relatorio_mensalidades_2026_1_sem_negociacao`): alunos são contados por `aluno_id` (`count(distinct e.aluno_id)`). CPF é indicador separado (`count(distinct e.cpf)`).
- 2026/2 segue a mesma regra. Alunos únicos pelo identificador interno; CPF complementar. Nenhuma consolidação automática por CPF.

## Funil de elegibilidade 2026/2

| Etapa | Títulos | Alunos | Saldo |
|---|---|---|---|
| Todos os títulos com vencimento em 2026/2 | 11.321 | 4.822 | R$ 18.756.974,97 |
| Situação ABERTO e status em_aberto | 9.961 | 4.179 | R$ 16.743.433,09 |
| Sem vínculo com acordo | 9.938 | 4.176 | R$ 16.706.480,11 |
| Sem caso cancelado ou jurídico | 9.937 | 4.175 | R$ 16.706.283,11 |
| Sem confirmação de pagamento pendente | 9.871 | 4.147 | R$ 16.598.401,64 |

## Decomposição da diferença entre alunos e CPFs (4.147 × 4.132)

- 15 CPFs compartilhados por 2 ou 3 alunos distintos (1 CPF com 3 alunos e 14 com 2). Efeito: +16 na diferença.
- 1 aluno com mais de um CPF normalizado. Efeito: −1.
- Líquido: +15, que é a diferença observada. A decomposição é aritmética e não foi rastreada linha a linha.
- 1 aluno com 78 títulos cujo CPF de origem tem mais de 11 dígitos. Saldo R$ 28.449,43. Não altera a diferença, mas não normaliza para um CPF válido.

## Impacto financeiro das inconsistências de CPF

- Títulos de CPFs compartilhados: cerca de R$ 84,7 mil, aproximadamente 0,5% do saldo elegível.
- CPF malformado: R$ 28,4 mil.

## Decisões registradas

- Nenhum título ou aluno é excluído por inconsistência de CPF. Só as regras financeiras já existentes filtram o universo.
- Os CPFs compartilhados não são consolidados. Exigem revisão humana.
- O relatório exibe alunos (chave interna) e CPFs como indicador complementar, com a diferença visível.

## Limites desta análise

- Não foi verificada a identidade real dos CPFs compartilhados (cadastro duplicado ou CPF digitado errado).
- Não foi rastreado o aluno com dois CPFs normalizados.
- Não foram verificados permissões, grants, RLS, rollback nem desempenho desta análise.
