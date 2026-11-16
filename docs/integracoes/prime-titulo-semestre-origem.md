# Origem de `prime_titulo_semestre.semestre`

Fonte: código do repositório. Verificado em 15/11/2026. Nenhuma classificação foi inventada.

## Quem preenche

- Tabela: `public.prime_titulo_semestre` (migration `20260825001000_prime_cadastro_contratos.sql`, linhas 61-72).
- Escrita: função que grava o cadastro do aluno a partir do payload do coletor. Migration `20260825001000` (linhas 157-168) e `20260902230000_o_nome_vem_do_prime.sql` (linhas 163-170), ambas com `INSERT ... ON CONFLICT (boleto) DO UPDATE`.
- Payload: montado pela edge function `supabase/functions/prime-cadastro/index.ts`.

## Como o valor é calculado (`prime-cadastro/index.ts`)

1. `semestreDe(validFrom)` (linhas 86-92): ano do contrato e `1` se o mês for até 6, senão `2`. Resultado no formato `AAAA/1` ou `AAAA/2`.
2. Os títulos são agrupados por série (prefixo do documento, linhas 133-139).
3. Para cada série, cada vencimento é associado ao contrato Prime que o cobre (linhas 161-164). O semestre da série é o que recebe mais votos (linhas 165-170). Em empate, vale o primeiro semestre contado (comparação estrita `n > melhor`). Série sem votos fica `null`.
4. O boleto recebe o `semestre` da sua série (linhas 172-175).

## O que isso significa

- O semestre não vem de um campo do boleto. É uma inferência pela data de início dos contratos Prime.
- Um boleto sem série ou sem vencimento coberto por contrato fica com `semestre = null`. A RPC nova trata esses casos pelo fallback por vencimento, o mesmo critério de `carteira_2026_2_negociacoes()`.
- Por isso o semestre é só tão bom quanto o contrato Prime que o sustenta.

## Dependência desta PR

`efetividade_caixa_resumo_semestre` usa essa coluna para separar caixa por semestre de origem. Esta documentação registra a origem. Não valida a qualidade do dado, e isso é uma tarefa separada.
