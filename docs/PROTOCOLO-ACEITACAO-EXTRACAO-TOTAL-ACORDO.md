# Protocolo de aceitação da extração TOTAL de `TIPO=ACORDO`

**Data:** 2026-10-07 · desenho, a partir de leitura em produção (`ahattpqrjmhkzsmnbdzs`)
**Modo: DOCUMENTAL.** Nenhuma migration, nenhuma alteração de registro, nenhuma
extração validada, nenhuma fila alterada, nenhum backfill. Toda medição citada
aqui veio de `SELECT`.

Continuação de [`J3-PRESENCA-POR-EXTRACAO-2026-10-01.md`](J3-PRESENCA-POR-EXTRACAO-2026-10-01.md),
que parou no Portão A por não ser possível provar que o Relatório de Títulos em
Aberto é snapshot completo.

---

## Por que este protocolo existe

O J3 provou que o relatório **não** é snapshot completo: a contagem de linhas de
acordo varia 85–93% dentro do mesmo dia, com mediana de 57 linhas contra 8.5 mil
parcelas abertas. Ausência entre dois desses arquivos não prova nada.

Uma auditoria posterior (07/10/2026) testou se as filas internas do CRM poderiam
substituir a extração como fonte de população. **Não podem:**

| Fila | Documentos | No universo | Cobertura |
|---|---:|---:|---:|
| Títulos `TIPO=ACORDO` | 379 | 264 | 3,1% |
| Pagamento sem vínculo | 392 | 5 | 0,1% |
| Acordos a confirmar (expandida) | 722 | 433 | 5,1% |
| **União** | **1.435** | **678** | **7,9%** |

E 97,9% dessa cobertura vem de filas alimentadas por `importacoes.tipo='ACORDOS'`
— o mesmo relatório parcial que motivou o J3. Removida a circularidade, sobra
**0,06%**. As filas são recortes operacionais de exceção, não censo.

Também foi testado `acordos.numero_ulbra` como segunda variável. **Não serve:**
é derivado do próprio documento (`substr(documento,4,5)` no importador) e confere
com o boleto em 13.155 de 13.206 parcelas — 99,6%. Usá-lo seria conferir o
documento contra ele mesmo. Fica valendo **apenas como chave para localizar o
acordo na tela do Prime**.

Logo: a completude depende de uma extração declaradamente total, e o que falta
não é a fonte — é o protocolo que decide se aceitar uma como tal.

---

## Âncora de referência

Medida em **2026-10-07**. Move-se com o tempo; **recongelar no instante da
conferência**, registrando o valor e o momento.

| | |
|---|---:|
| Boletos elegíveis (acordo `ATIVO` + parcela `A_VENCER`/`VENCIDA`) | **8.534** |
| Acordos `ATIVO` vivos | **2.262** |
| Unidades vivas | **22** |

Congelar essa contagem **não é criar baseline**: é a medida própria do CRM, usada
como referência de reconciliação.

---

## Camada 1 — Controle do arquivo

Aplica-se à **união deduplicada** de todas as partes. Cada parte pode conter
qualquer subconjunto de unidades e períodos — uma parte incompleta não é defeito.

### 1A. Integridade, por arquivo

| Verificação | Critério |
|---|---|
| SHA-256 | Calculado e registrado antes de qualquer processamento |
| Totais de controle próprios | Rodapé/somatório declarado no arquivo = linhas efetivamente lidas. Divergência = arquivo truncado |
| Carimbo de extração | Data, hora e precisão declaradas. Ausente = **inconclusivo** |
| Declaração de parâmetros | Escrita, de quem extraiu, nomeando os filtros usados ou afirmando que nenhum foi usado |
| Partes previstas | Quantas e quais. A união é o objeto de teste |

### 1B. Triagem

| Verificação | Critério |
|---|---|
| `TIPO=ACORDO` isolado e contado | Subconjunto separado do resto |
| Duplicidades de documento na união | Contadas e explicadas |
| Linhas descartadas | Contagem + quebra por motivo |
| **Cobertura < 95% do universo congelado** | **Alerta: suspende para reconciliação.** Não reprova por si — diferenças legítimas e comprovadas podem explicar cobertura menor. Retomar apenas com cada ausência explicada |

Passar na triagem **não aprova nada**.

### 1C. Reconciliação integral do universo conhecido pelo CRM

> **Toda ausência precisa de categoria nomeada e evidência. Zero ausências sem
> explicação, em qualquer nível de cobertura.**

| Categoria | Evidência exigida |
|---|---|
| Liquidado antes da extração | Registro de baixa anterior ao carimbo |
| Criado depois da extração | **Evidência na origem** de que o título não existia no Prime no carimbo. `criado_em` do CRM **não serve**: entrada tardia no CRM não explica, sozinha, ausência no arquivo |
| Acordo cancelado entre o congelamento e a extração | Mudança de status datada |
| Vínculo possivelmente errado no CRM | Pertence aos 46 identificados neste documento — **hipótese a confirmar no Prime**, nunca dispensa |
| Sem explicação | **Reprova** |

### 1D. Completude na origem — o que o CRM não responde

O CRM não conhece o universo do Prime. Três coisas endereçam isso, em ordem
crescente de força:

1. **Totais de controle da própria extração** — provam que o arquivo não foi
   cortado; **não** provam que não foi filtrado.
2. **Contagem agregada na tela do Prime**, se a tela a expuser.
3. **Relação independente obtida no Prime, com abrangência e data comprovadas** —
   a única que permite reconciliação de verdade.

Registrados como indício, **sem poder de prova**: presença ou ausência de coluna
ou nome de borderô, datas mínima e máxima, lista de unidades. Nenhum deles prova
que houve ou não houve filtro, em qualquer direção.

---

## Camada 2 — Amostragem

### Limite de alcance, declarado antes de executar

**Amostra tirada do CRM só sustenta conclusão sobre acordos que o CRM conhece.**
Acordo que existe no Prime e não existe no CRM é invisível para ela, por
construção.

Para testar completude além desse universo, a amostra precisa ser sorteada de uma
**relação independente obtida no Prime**. Sem ela, o teste é de reconciliação,
não de completude.

### Como a amostra é tirada

1. Congelar a lista de acordos `ATIVO` com parcela em aberto; registrar contagem
   e instante.
2. Sortear com semente registrada, para ser reproduzível e não re-sorteável
   depois de ver o resultado.
3. **Só então** abrir a extração.

`numero_ulbra` entra apenas como endereço para localizar o acordo na tela.

### Bloco A — probabilístico

Aleatória simples sobre os acordos `ATIVO` vivos. **Só este bloco carrega
afirmação estatística.**

| n | Teto superior da proporção de acordos defeituosos, 95%, **se zero defeitos** |
|---:|---|
| 60 | ≤ 5,0% |
| 95 | ≤ 3,1% |
| 299 | ≤ 1,0% |

Pressupostos declarados: amostragem aleatória simples, sem reposição, defeito
binário por acordo, zero defeitos observados. Qualquer defeito invalida o teto —
não se recalcula para acomodar. **O n se escolhe pelo teto que se quer afirmar**,
não por outras medidas da base.

### Bloco B — dirigido

**Sem garantia estatística.** Sondas para modos de falha plausíveis: um acordo de
cada unidade viva; extremos de vencimento, de saldo e de quantidade de parcelas;
alguns dos 44 acordos com vínculo suspeito. Achado aqui **reprova**; ausência de
achado **não aprova**.

### O que se compara, por acordo

Quantidade de títulos em aberto na tela do Prime, os documentos, e os valores
quando a tela os exibir — contra o que a união trouxe.

### Regra de decisão

| Situação | Veredito |
|---|---|
| Título aberto na tela, ausente na união, **com evidência na origem** de que já estava aberto no carimbo | **Defeito — reprova** |
| Documento na união, ausente na tela, **com evidência na origem** de liquidação posterior ao carimbo | Diferença temporal — registra |
| Qualquer divergência **sem evidência de origem do momento da mudança** | **Inconclusivo — precisa ser resolvido** |
| Divergência de valor com contagem correta | Registra à parte. Saldo corrigido e original são grandezas distintas |

**Os 44 acordos com vínculo suspeito não têm isenção.** O diagnóstico pelo número
do boleto é indício de vínculo errado no CRM, não confirmação no Prime. Cada um é
conferido na tela como qualquer outro, e **um mesmo acordo pode ter erro no CRM e
falta real na extração** — as duas coisas se somam, não se anulam. Sorteado,
permanece na amostra: não se exclui nem se substitui.

**Diferenças temporais comprovadas** não reprovam por incompletude. Acima de 10%
dos amostrados, indicam extração velha demais para servir de referência →
**reextrair**.

---

## Camada 3 — Gate

Todas simultaneamente verdadeiras:

1. Camada 1A completa em cada parte: hash, totais de controle batendo, carimbo e
   declaração de parâmetros.
2. Triagem 1B executada. Se a cobertura ficou abaixo de 95%, a suspensão foi
   resolvida com cada ausência explicada.
3. **Reconciliação 1C integral: zero ausências sem categoria e evidência.**
4. Camada 1D endereçada, com o resultado declarado explicitamente.
5. Amostra sorteada **antes** de abrir o arquivo, com semente registrada.
6. Bloco A executado no n escolhido, com evidência por acordo: **zero defeitos**.
7. Bloco B executado: **zero achados**.
8. **Zero inconclusivos. Todo caso selecionado resolvido.** Inconclusivo não vira
   aprovação em nenhuma proporção.
9. Diferenças temporais ≤ 10% dos amostrados, ou extração refeita.
10. Os 44 conferidos individualmente na tela, sem isenção.
11. Nenhuma fila usada como censo em nenhuma etapa.
12. `numero_ulbra` usado só para localizar o acordo na tela.
13. As 16 extrações antigas intactas e permanecendo classificadas como parciais.

Falhando qualquer uma: **não validar**. Registrar a falha e repetir a extração —
não ajustar o critério.

---

## Os carimbos, e o que cada um afirma

### `RECONCILIADA_COM_CRM` · `COMPLETUDE_NA_ORIGEM_NÃO_COMPROVADA`

O que o protocolo produz **sem** uma relação independente do Prime.

Afirma: a extração reconcilia integralmente com o universo que o CRM conhece.
**Não afirma** que o Prime não tem mais nada.

Consequência que precisa estar escrita na tela: **ausência nessa extração não
libera nenhuma conclusão automática de pagamento ou baixa.**

### `COMPLETUDE_TESTADA_POR_AMOSTRA`

Exige uma relação independente obtida no Prime, **com abrangência e data
comprovadas**, da qual se sorteia a amostra.

Afirma: a hipótese de completude sobreviveu a uma amostra independente, com o
teto estatístico declarado (ver tabela do Bloco A). O teto é parte do carimbo —
`COMPLETUDE_TESTADA_POR_AMOSTRA (n=95, teto 3,1%)`.

**Amostrar não é reconciliar.** Este carimbo não equivale ao seguinte.

### `TOTAL_VALIDADO`

Exige **reconciliação integral** com uma relação do Prime cuja **abrangência e
data estejam comprovadas** — não amostra dela.

Enquanto essa relação não existir, este carimbo não é emitido.

### O que nenhum carimbo autoriza

**Nem mesmo uma extração completa transforma ausência em pagamento confirmado.**

Ausência indica **saída do conjunto**. Pagamento ou baixa exige **evidência
específica da origem** — a fonte não distingue pagamento de cancelamento, bolsa,
renegociação ou mudança de recorte. Isto vale em todos os níveis de carimbo, sem
exceção.

---

## Achado registrado à parte: as 51 parcelas

Medido em 2026-10-07. **Não corrigido, não tocado.** Nenhum registro alterado.

51 parcelas cujo `boleto` codifica um acordo diferente do `numero_ulbra` do
acordo a que estão penduradas:

| | |
|---|---:|
| Divergentes | **51** — 48 `QUITADO/PAGO`, 2 `CANCELADO/CANCELADA`, 1 `ATIVO/A_VENCER` |
| Intersectam o universo elegível diretamente | **1** · R$ 384,81 |
| Boletos cujo número pertence a acordo `ATIVO` vivo | **46** · **R$ 86.070,72** |
| Acordos `ATIVO` vivos afetados | **44** de 2.262 — **1,9%** |
| Boleto duplicado em `parcelas` | **0** |

Como o boleto **não está duplicado**, o acordo `ATIVO` não tem essa parcela no
CRM: ela está pendurada em outro acordo. Se a extração trouxer esses 46 em aberto,
o CRM tenderá a classificá-los como fora do universo ou como excesso. Se o Prime
confirmar o vínculo e a situação em aberto desses boletos, a divergência será
atribuída ao CRM.

**São hipóteses de vínculo errado, não vínculos errados confirmados.** A
confirmação só vem da tela do Prime, acordo a acordo. Estar em acordo `QUITADO`
não prova que o vínculo esteja certo nem que esteja errado.

Entram no protocolo como **categoria de reconciliação a verificar**, nunca como
dispensa. Decidir sobre elas antes da validação evita confundir o diagnóstico de
um resultado reprovado.

---

## O que este documento NÃO fez

- Não validou nenhuma extração.
- Não criou baseline.
- Não gerou arquivo sintético.
- Não usou filas como censo.
- Não usou `numero_ulbra` como prova de independência.
- Não alterou as 16 extrações antigas, que permanecem classificadas como parciais.
- Não corrigiu as 51 parcelas.
- Não aplicou migration nem alterou registro algum.
