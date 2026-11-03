# Projeção parcial desde o 1º dia útil

Regra definida pela gestão em **03/11/2026**. Vale para a Projeção Hora a Hora
(filial e operador) e para a TV corporativa.

## A regra

A projeção de fechamento deve existir **desde o primeiro dia útil do mês**, com
o honorário já realizado, mesmo com o dia em andamento.

```
base     = dias úteis de 1º do mês até hoje (hoje INCLUSO)
projeção = honorário acumulado ÷ base × dias úteis totais do mês
```

- **1º dia útil:** acumulado ÷ 1 × total.
- **Dias seguintes:** dias já encerrados **+ o dia em andamento**.
- **Dia não útil** (sábado, domingo, feriado): não há dia em andamento, a base é
  só o que fechou.
- **Mês encerrado:** base = total, projeção = realizado. Consolidado, como já era.
- **Feriados:** sempre pela tabela `public.feriados` e pelo helper oficial
  `public.dias_uteis(ini, fim)`. Nada de contar dia da semana na mão.

Exemplo conferido com a gestão — **03/11/2026**, primeiro dia útil de novembro
(01 foi domingo, 02 foi Finados):

| | |
|---|---|
| Honorário acumulado | R$ 4.073,80 |
| Dias úteis do mês | 19 |
| Base do ritmo | 1 |
| **Projeção parcial** | **R$ 77.402,20** |

## Por que a projeção estava parada

Não estava desatualizada: o snapshot de 03/11 foi gerado às 15:45 do próprio dia.
A regra vigente até aqui (premissa de 2026-08-17, *"só dia fechado entra no
ritmo"*) descontava o dia corrente da base. No 1º dia útil isso dá base **0**, e
com base 0 as funções caem no `else` e devolvem a projeção **igual ao realizado**
— R$ 4.073,80, 3,33% da meta. O número parecia congelado porque, pela regra
antiga, não havia ritmo de onde projetar.

## Onde mora a conta

Três funções em produção, uma linha cada:

| Função | Papel | Linha que muda |
|---|---|---|
| `public.projecao_calcular_filial(text)` | snapshot FILIAL do CRM | desconto do dia corrente |
| `public.projecao_calcular_operador(text,text)` | snapshot por operador | desconto do dia corrente |
| `public.tv_snapshot_calcular()` | snapshot da TV | desconto do dia corrente |

`public.projecao_dashboard` tem o mesmo furo e **não foi tocada de propósito**:
é legado, a tela não a chama mais, e ela ainda conta dia útil por dia da semana
(sem feriado). Fica anotada.

A conta continua **só no banco**. O CRM e a TV leem `projecao_parcial` do payload
e não recalculam nada — é o que impede a projeção de ter duas contas diferentes
nas duas telas.

## O que entra no payload

`projecao_parcial` (boolean): true enquanto o dia corrente está na base, isto é,
hoje dentro do mês de referência **e** hoje é dia útil.

Na tela:

- **CRM**, visão da gestão, da diretoria e rodapé do operador: selo
  **PROJEÇÃO PARCIAL** ao lado da projeção, com explicação no *title*.
- **TV**, *Resultado do Mês*: `PARCIAL — o dia ainda está em andamento` no card
  da projeção.
- **TV**, *Meta do Mês* e *Magic Number*: ` · PARCIAL` no rodapé da projeção.

## O que NÃO muda

- Valor realizado, recuperado e honorário: nenhuma linha de pagamento é lida de
  outro jeito.
- Metas (`metas_projecao`) e faixas/percentuais de comissão.
- **Dias úteis restantes** segue contando hoje (o dia ainda vai fechar), então
  "média diária necessária" e "necessário por dia útil" não se movem. Na TV a
  fórmula de restantes passou a ser a mesma do CRM — mesmo valor hoje
  (19), e de quebra conserta sábado/domingo, em que a antiga devolvia 1 a mais.
- **Mês fechado**: o `if v_hoje <= v_fim` já era falso. Outubro/2026 segue 21/21
  com projeção = realizado. Nenhum fechamento histórico é reescrito.

## Dia corrente é dia local

`projecao_calcular_filial/operador` usavam `current_date`, que no banco é **UTC**.
Às 21h locais o UTC vira, e a base ganharia um dia útil sem honorário nenhum —
às 21h de 03/11 a projeção cairia de R$ 77.402,20 para R$ 38.701,10. Com o dia
corrente **dentro** da base isso deixa de ser detalhe, então `v_hoje` passa a ser
a data de `America/Sao_Paulo`. Efeito colateral bem-vindo: os cartões "hoje"
param de trocar de dia às 21h.

`tv_snapshot_calcular` fica com `current_date` no bloco de dias úteis — o cron da
TV roda 11–23 UTC (8h–20h local) e nunca cruza a virada. Pendência própria, fora
desta correção.

## Atualização sem intervenção manual

- **TV: já é automática.** Cron `jobid 85`, `*/15 11-23 * * 1-5`, chamando
  `tv_snapshot_atualizar()` atrás do disjuntor `sistema_sob_carga()`. A cada 15
  minutos em dia útil, das 8h às 20h locais.
- **CRM: continua manual** (botão "Atualizar projeção"). **Não existe cron** para
  `projecao_snapshot_atualizar` — e isso é desenho, não esquecimento: o snapshot
  manual nasceu justamente para tirar a Projeção Hora a Hora do polling depois do
  incidente de saturação do Supabase.

  Ligar um cron aqui é **decisão da gestão**, com duas pendências reais:

  1. **Autorização** — cron é alteração de banco com custo contínuo; precisa de
     autorização específica.
  2. **Autorização interna da RPC** — `projecao_snapshot_atualizar` autoriza por
     allowlist de e-mail lida do JWT. Cron não tem JWT, então a chamada falharia
     como está: seria preciso um caminho de serviço (p. ex. um wrapper
     `projecao_snapshot_cron()` chamando `projecao_calcular_*` direto, com o
     mesmo disjuntor do job 85).

  **Nada disso está incluído nesta entrega.** Com a regra aplicada, cada clique
  no botão já traz a projeção parcial correta; a automação é o passo seguinte, se
  a gestão quiser.

## Arquivos

| Arquivo | O que é |
|---|---|
| `proposta.sql` | o patch, ancorado sobre `pg_get_functiondef`. **Não aplicado.** |
| `rollback.sql` | o inverso exato do patch. |
| `supabase/tests/projecao_parcial_dia_corrente.test.js` | a regra em Postgres real (PGlite) + escopo/segurança da proposta |
| `src/components/tv/tvProjecaoParcial.test.jsx` | selo nas três telas da TV |
| `src/pages/ProjecaoHoraHora.projecaoParcial.test.jsx` | selo no CRM |

## Como aplicar

1. Rodar `proposta.sql` inteiro (uma transação; qualquer âncora que não casar
   aborta tudo e nada é gravado).
2. Conferir a saída do `select` final: `tem_flag = t`, `tem_desconto = f`, e os
   grants iguais aos de antes — **`CREATE OR REPLACE` devolve execute para
   PUBLIC**, e por isso o script repõe os grants no fim.
3. Regerar os snapshots: botão "Atualizar projeção" no CRM; na TV, esperar o
   cron 85 ou chamar `tv_snapshot_atualizar()`.
4. Conferir em novembro/2026: base 1 · total 19 · realizado 4.073,80 ·
   projeção 77.402,20 · parcial true.
