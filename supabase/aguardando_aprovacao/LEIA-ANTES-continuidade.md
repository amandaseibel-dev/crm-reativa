# Continuidade da cadência WhatsApp — qual arquivo aplicar

**Atualizado em 10/11/2026.**

## NÃO aplique a v1

`supabase/migrations/20261030090000_whatsapp_cadencia_continuidade_e_limite_5.sql`

Esta migration **já está em `supabase/migrations/` no main** e **não pode ser movida,
renomeada, apagada nem editada**: a catraca das migrations (`scripts/ci/catraca-migrations.mjs`)
bloqueia as quatro ações (regras I1, I2, I3). Uma tentativa de movê-la para
`aguardando_aprovacao/` foi barrada pelo CI em 10/11/2026 e revertida.

Ela continua a ser perigosa: produção está no estado 3/2 que a v1 aceita, então
`supabase db push` a aplicaria sem erro e implantaria a regra errada. **Este PR não
aumenta essa exposição, mas também não a remove.** Remover exige decisão da equipe sobre
como neutralizar migrations superadas sem apagá-las. Ver a seção "Decisão pendente".

**Por que está errada:** ela ancora a continuidade em `whatsapp_abordagens`, exigindo uma
linha de abordagem anterior do mesmo operador na mesma conversa. Mas `RESPOSTA` retorna
**antes** do INSERT naquela tabela, então conversa que estava viva como resposta e esfriou
não tem linha nenhuma.

Medido em 09/11/2026: cobriria **1 de 5** casos reais e **9 de 96** abordagens de 7 dias (~9%).

Ela também embutia aumento de limite (`teto_abordagens_operador` 3→5 e Comercial
`limite_abordagens_operador` 2→5), que não foi autorizado.

## Decisão pendente

Como superar a v1 sem violar a catraca? Opções que exigem aprovação da Amanda:

1. Uma migration nova, com timestamp posterior, que apenas reafirme a função v2 — não
   remove a v1, mas garante que a v2 seja a última a valer no `db push`.
2. Uma exceção explícita e nomeada na catraca para migrations marcadas como superadas.
   Isto afrouxa uma regra de segurança do CI e só deve ser feito com aprovação.

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
