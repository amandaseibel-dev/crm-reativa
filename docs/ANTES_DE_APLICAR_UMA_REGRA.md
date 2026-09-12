# Antes de aplicar uma regra em lote

Regra da Amanda, 09/09/2026, depois de quatro erros meus no mesmo dia:
**revisar duas ou mais vezes antes de aplicar qualquer regra.**

Este arquivo existe porque a promessa de lembrar não bastou. É checklist, não
intenção.

## Os quatro erros do dia, e a causa comum

| Erro | Custo | Como escapou |
|---|---|---|
| Trava de ficha única abortando o lote | Importação da projeção morreu | Testei o caminho do cron, não o da importação |
| 1.530 títulos vinculados sem checar pagamento | R$ 2.012.553,84 saíram da cobrança | A regra estava escrita e eu não a apliquei |
| Duas checagens do vigia lendo o boleto errado | Reportaram zero por dois dias | Nunca conferi se o predicado *podia* casar |
| 273 parcelas "renegociadas" apontando para o próprio acordo | R$ 275.623,06 de dívida legítima removidos | "382 de 395 casam" pareceu prova |

**A causa é sempre a mesma:** validei a regra com **uma variável só**, e usei o
número de casamentos dela como se fosse prova.

## A regra central: confirmar com uma variável independente

Não basta a regra casar. Ela tem que casar **e** ser confirmada por uma variável
de **outra natureza** — outro campo, outra tabela, outro sistema. Contar mais
casamentos da mesma variável não é confirmação; é a mesma evidência repetida.

Olhando os quatro casos por essa lente, o padrão é exato:

| Regra | Variável usada | Segunda variável independente | Resultado |
|---|---|---|---|
| Re-acordo | o boleto casa com o título | **nenhuma** | Errado — 273 circulares |
| Elo da mensalidade | data de liquidação no Prime | gabarito, mas **não o pagamento** | Errado — 383 simulações |
| Checagens do vigia | fatia do boleto | **nenhuma** | Errado — zero falso |
| Baixa sem lastro | não existe pagamento | **quem assinou a baixa** | **Certo** |

A única que deu certo foi a única em que cruzei com uma variável de natureza
diferente. E o custo de não fazer isso não é só o erro: **aplica-se e depois é
preciso corrigir em todos os pontos** — saldo do acordo, status da parcela,
situação do título, fila do operador, honorário, projeção.

## O checklist

1. **Ensaio primeiro.** Contar sem escrever. Toda rotina nasce com
   `p_confirmar boolean default false`, e o padrão é não escrever.

2. **Olhar o conjunto ao contrário.** A pergunta não é *quantos a regra pega* —
   é *o que mais casa com este predicado*. Listar cinco casos e ler um a um.
   Foi aqui que os 273 circulares passaram: eu contei os casamentos e não olhei
   para onde eles apontavam.

3. **Abrir UMA ficha de verdade.** Uma ficha real derrubou uma conclusão que
   382 casamentos não derrubaram. Sempre uma, à mão, antes de aplicar.

4. **Validar contra gabarito**, quando existir resposta conhecida. Foi o que
   salvou o elo da mensalidade: aplicada aos acordos de composição conhecida, a
   regra reproduziu a lista exata em 681 de 685.

5. **Perguntar quem assinou.** Dado feito por gente não sai por rotina. Das 467
   baixas sem pagamento, 332 eram legítimas — o discriminador era
   `confirmado_por_email`, não a ausência de pagamento.

6. **Nunca aplicar com evidência de um lado só.** Se a regra fala do Prime, o
   Prime precisa responder. O que ele não entrega (portador 166) fica esperando.

7. **Backup com RLS deny-all e origem própria** no registro escrito, para
   desfazer exatamente aquilo e nada mais.

8. **Conferir depois de aplicar — e conferir o efeito em cadeia.** Excluir as
   baixas sem lastro fez 20 acordos virarem simulação *depois* de um desfazer
   anterior. A segunda ordem de efeito não aparece no ensaio.

## As regras de negócio que qualquer rotina tem de obedecer

- Baixa só pelo **número do título**. Nunca por nome, valor ou data.
- **Acordo só vale com pagamento.** Sem pagamento é simulação: a dívida continua
  sendo da mensalidade.
- **Não cancela mensalidade, sempre vincula.** A dívida não some — para de somar
  e fica na memória do acordo.
- **Acordo cancelado devolve a mensalidade**, e ela continua visível na
  composição do acordo.
- **Duplicidade se sinaliza, não se apaga.**
- **Baixa automática pelo Prime é proibida.**
- **Guarda que aborta é guarda quebrada.** Nenhuma trava derruba o lote: trata o
  que consegue e registra o resto.
