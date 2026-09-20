# Ações Massivas: melhorias futuras (NÃO implementadas)

Registro de 20/09/2026, depois da entrada em produção do universo/cobertura (PR #437).
**Nada aqui foi feito.** Não há tabela agregada, índice novo nem alteração de RPC por performance.

## Performance medida em produção (tela real, 20/09/2026)

| Ação | Tempo |
|---|---|
| Abrir o painel de cobertura | ~4,7 a 6,5 s |
| Gerar a prévia | ~3,5 a 9,4 s (mediana ~7 s; menor quando o universo é filtrado) |
| Cada página do drill-down | ~4,4 a 9,1 s (mediana ~4,9 s; 49 chamadas) |

- Cada página do drill-down **recalcula o universo inteiro** (`acoes_massivas_universo`); percorrer uma lista de 1.470 alunos (30 páginas) leva ~4 minutos.
- Componentes medidos em leitura: `liquidados_prime` ~0,6 s; `caso_encerrado_operacional` ~0,85 s (17,9 mil alunos); agregação de cobertura por movimentação ~0,85 s; `tipo_cobranca_alunos` ~0,2 s; a regra de finalização desfeita custa ~0,02 s.
- O custo vem de funções por linha e de uma varredura de `aluno_movimentacoes`, não de falta de índice (nenhum índice novo foi justificado por evidência).
- Sem erros nas chamadas; sem chamadas duplicadas (1 por clique).

## Ideias, para decidir depois (nenhuma autorizada)

1. Guardar a cobertura já agregada por aluno (tabela ou visão materializada) e reutilizá-la em painel, prévia e drill-down.
2. Reaproveitar o universo entre páginas do drill-down (paginar sobre um resultado já calculado).
3. Reduzir o custo de `caso_encerrado_operacional` / `liquidados_prime` no universo.
4. Só criar índice se um `EXPLAIN` mostrar varredura evitável.

Qualquer uma exige nova autorização e novo preflight.
