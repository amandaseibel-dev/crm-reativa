# Continuidade da cadência WhatsApp — qual arquivo aplicar

**Atualizado em 09/11/2026.**

## NÃO aplique a v1

`20261030090000_whatsapp_cadencia_continuidade_e_limite_5.sql.SUPERSEDIDA`

Foi **movida para fora de `supabase/migrations/`** em 09/11/2026 (`git mv`, histórico
preservado) justamente para não ser aplicada por engano. O arquivo estava lá com teste
e rollback, com aparência de pronto, e **a produção está no estado 3/2 que ela aceita** —
ou seja, ela aplicaria sem erro e implantaria a correção errada.

**Por que está errada:** ela ancora a continuidade em `whatsapp_abordagens`, exigindo uma
linha de abordagem anterior do mesmo operador na mesma conversa. Mas `RESPOSTA` retorna
**antes** do INSERT naquela tabela, então conversa que estava viva como resposta e esfriou
não tem linha nenhuma.

Medido em 09/11/2026:

| | |
|---|---|
| Casos reais de 09/11 que a v1 cobriria | **1 de 5** |
| Abordagens de 7 dias com abordagem anterior do mesmo operador | **9 de 96** (~9%) |

Ela também embutia aumento de limite (`teto_abordagens_operador` 3→5 e Comercial
`limite_abordagens_operador` 2→5), que é decisão separada e não foi autorizada.

### O que foi preservado de propósito

- O arquivo da v1, renomeado com sufixo `.SUPERSEDIDA` — não foi apagado.
- `supabase/rollbacks/20261030090000_...rollback.sql` — intacto.
- `supabase/tests/whatsapp_cadencia_continuidade/` (01, 02, 03) — intacto, como
  registro do desenho anterior.

## Aplique a v2, depois de aprovada

`20261109120000_whatsapp_continuidade_v2.sql.pendente`
`20261109120000_whatsapp_continuidade_v2.rollback.sql`

Testes: `supabase/tests/whatsapp_continuidade_v2/` — ordem de execução

```
01_ambiente.sql  →  02_antes_v2.sql  →  <migration v2>  →  03_casos_v2.sql
```

`02_antes_v2.sql` mede a regra ATUAL nos mesmos cenários e produz a coluna de
comparação; `03_casos_v2.sql` roda 17 cenários e imprime o comparativo
"regra atual × v2" no final.

**Status em 09/11/2026: não aplicada, não aprovada.** A extensão `.pendente` impede
que o CLI do Supabase a colete.
