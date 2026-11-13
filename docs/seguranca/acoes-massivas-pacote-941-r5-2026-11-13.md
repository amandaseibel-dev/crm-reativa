# Ações massivas: pacote da #941 com R5 integrada (13/11/2026)

Status: **não aplicado em produção.** Nenhuma migration aplicada, nenhuma massiva disparada.

## Hashes (definição de `acoes_massivas_universo`)

| Estado | MD5 | Origem |
|---|---|---|
| Publicado hoje | `8f94a1687f0f3d13765ecf86db1d1e19` | #935 (dono do acordo) |
| Após #941 (valor/faixa) | `52f8ca6c4e4428e9dc5d0912e2b9751a` | `20261112235500` |
| Após R5 (elegibilidade) | `78e55b9a43598129831b18ff62e50e40` | `20261112235600` |
| Após desempenho | a definir pela sessão de otimização | a partir de `78e55b9a…` |

Commits no worktree `fix/acoes-massivas-r5-integrado` (sem push):
- `f6424128`: #941 publicada (base)
- `be63c81c`: R5 integrada

## Ordem e dependências

1. `20261112235500` (#941): valor exigível e faixa. Exige `8f94a168…`.
2. `20261112235600` (R5): elegibilidade. Exige `52f8ca6c…`. Não aplicar antes da #941.
3. Migration de desempenho: exige `78e55b9a…`.

Rollback na ordem inversa: reverter a de desempenho, depois `20261112235600` (restaura `52f8ca6c…`), depois `20261112235500` (restaura `8f94a168…`). Cada rollback confere o hash de entrada e recusa execução fora de ordem.

## O que cada migration muda

- **Valor (#941):** `valor` e filtro de faixa passam a ser o valor exigível (mensalidade vencida independente + parcela vencida de acordo ativo). Não usa `casos.total_em_aberto`.
- **Elegibilidade (R5):** aluno só-parcela entra com evidência R5. Caso encerrado antigo não autoriza. `total_em_aberto` nulo não autoriza. Caso aberto com total positivo continua autorizando (preserva a população atual).
- **Desempenho:** sem mudança de regra. Pendente da sessão de otimização.

## Validação funcional (ambiente isolado, feita)

- `acoes_massivas_valor_exigivel.test.js`: 35/35 (#941 sem R5).
- `acoes_massivas_r5_sobre_valor.test.js`: 18/18 (R5 sobre a #941). Cobre: sem caso; caso encerrado antigo com saldo positivo; total nulo; caso aberto preservado; cada evidência R5; vencimento futuro; valor independente do caso.
- Consumidores que carregam fixture própria (universo_comportamento, tipo_cobranca, responsavel_caso_e_acordo etc.) não executam esta definição; não foram rodados nesta rodada.

## Validação limitada para implantação autorizada (não executar sem autorização)

1. Conferir MD5 de entrada (`8f94a168…`), depois aplicar `20261112235500` em transação e conferir `52f8ca6c…`.
2. Aplicar `20261112235600` em transação e conferir `78e55b9a…`.
3. Conferir ACL: `anon` e `authenticated` sem EXECUTE; `service_role` com EXECUTE; sem PUBLIC.
4. Prévia com **um** recorte de baixo volume (um responsável, um ano), timeout explícito, sem exportar nem registrar.
5. Não rodar o universo completo para comparação enquanto o incidente de timeout estiver aberto.

## Pendências antes de publicar

- Revisão do Guardião (em andamento).
- Medida de impacto no universo completo em ambiente isolado (não feita).
- Decisão sobre o valor de alunos R5 que incluem parcelas sem evidência: `val_acordo` ainda soma todas as parcelas vencidas do acordo ativo, não só as que passam no R5. Ver PR.
- Dois casos "Quitado" (`addd943d…`, `ab8ac2df…`): não alterados; dependem de conferência no Prime.
