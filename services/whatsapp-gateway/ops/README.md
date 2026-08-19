# Indicadores do piloto

Os sete indicadores acordados para acompanhar o piloto, e o veredito do limite
de 2% de `LID_SEM_VINCULO`.

## Contadores do gateway

```bash
curl -s http://127.0.0.1:3000/saude | python3 -m json.tool
```

Campos que importam: `aceitas`, `resolvidas_por_lid`, `retidas_por_lid`,
`descartes`, `fila_pendente`, `quarentena`.

**Atenção à janela:** estes contadores vivem no processo e **zeram a cada
reinício do gateway**. A taxa calculada sobre eles vale para o período desde o
último reinício, não para o piloto inteiro. O que é cumulativo está no banco.

## Indicadores no banco

Rode `piloto-indicadores.sql` em produção (só leitura). Devolve entradas,
conversas, "sem retorno", badge de não lidas, sem responsável, tempo médio até a
primeira resposta, quedas, reconexões, alertas e heartbeat.

## O limite de 2%

    taxa = LID_SEM_VINCULO / (aceitas + LID_SEM_VINCULO)

Acima de 2%, tratar como bloqueador antes de ampliar para os 11 operadores.

**Cuidado com amostra pequena:** com poucas dezenas de mensagens, um único
descarte já estoura o limite sem que isso signifique um problema sistêmico. O
limite só é informativo a partir de algumas centenas de entradas — antes disso,
olhe o número absoluto e o motivo de cada descarte, não a porcentagem.
