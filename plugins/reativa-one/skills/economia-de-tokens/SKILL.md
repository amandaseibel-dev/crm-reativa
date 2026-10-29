---
name: economia-de-tokens
description: Diz, por critério objetivo, qual modelo, qual nível de esforço e quantos subagentes cabem em cada tipo de tarefa do CRM ReATIVA, e o que não repetir — leitura, auditoria, contexto, resposta. Use antes de abrir subagente, antes de varrer arquivo grande, antes de subir de modelo e sempre que a tarefa parecer pedir o modelo mais forte sem motivo declarado.
---

# Quanto gastar nesta tarefa

Esta skill **não contém regra de negócio**. Ela diz *quanto* gastar; *o que*
decidir continua em `docs/`, roteado pela skill `fontes-de-verdade`.

**Princípio:** o menor consumo que preserva qualidade, segurança e precisão.
Economia que produz número errado não é economia — neste repositório um saldo
errado custa mais que qualquer token.

## Quem decide o quê (ler antes de tentar aplicar)

| Decisão | Quem decide | Onde |
|---|---|---|
| Modelo/esforço da **sessão em curso** | a gestão, no app ou em `/model` e `/effort` | não se muda por conta própria |
| Teto de esforço | arquivo versionado | `maxEffortLevel` em `.claude/settings.json` |
| Modelo/esforço de **subagente** | **você**, no spawn | `model:`/`effort:` em `agents/*.md`; `CLAUDE_CODE_SUBAGENT_MODEL` é o padrão |
| Modelo do turno de um **comando** | o arquivo do comando | `model:`/`effort:` em `commands/*.md` |
| Quanto ler, quantos agentes, tamanho da resposta | **você** | esta skill |

Pedir para "trocar o modelo desta resposta" não existe: o que está sob sua
decisão é a linha 3, a 4 e a 5 desta tabela.

## Modelo: critério objetivo

| Use | Quando — basta um item |
|---|---|
| `haiku` | a resposta é a saída de um script ou de um arquivo lido, sem julgamento: `/reativa-one:ambiente`, `/reativa-one:escopo`, conferir se arquivo/linha/função existe |
| `sonnet` | **padrão.** Correção localizada, teste de módulo, leitura de trecho, roteamento de fonte, relatório de diff — até ~5 arquivos tocados, nenhuma regra de banco, segurança ou dinheiro |
| modelo da sessão (`inherit`) | toca RLS/grant/`SECURITY DEFINER`/migration · conclui ou reconcilia valor financeiro · decide quem entra em fila · cruza Prime/ULBRA · audita diff antes de PR · ou duas tentativas em `sonnet` já falharam |

**Subir de modelo exige dizer qual item acionou**, em uma linha. Descer não
exige nada.

## Esforço: critério objetivo

| Nível | Quando |
|---|---|
| `low` | saída determinística: rodar script, listar, confirmar presença |
| `medium` | **padrão** de implementação e correção |
| `high` | auditoria de segurança, prova de causa, conciliação financeira, qualquer resposta que vire decisão de produção |
| `xhigh` / `max` | **indisponível**: o teto versionado é `high`. Se a tarefa precisar de mais, isso é decisão de arquivo e de gestão, não de sessão |

## Quantos subagentes

| Quantos | Quando |
|---|---|
| **nenhum** — faça aqui | cabe em ~5 chamadas de ferramenta, ou você já sabe o arquivo |
| **um** | varredura ampla da qual você só quer a conclusão ("onde mais existe esta fórmula de saldo?"), ou a auditoria pelo `guardiao` |
| **dois ou três em paralelo** | só com dimensões independentes: nenhuma lê o resultado da outra, nenhuma escreve nos mesmos arquivos |

Nunca: agente para reler o que já está no contexto · agente para rodar um
comando · um segundo agente para reconferir a conclusão do primeiro —
reconferência é trabalho do `guardiao`, uma vez.

## Repetição que custa e não paga

- **Arquivo já lido não se relê.** Falta outro trecho? `sed -n 'A,Bp'` ou
  `rg -n <padrão>`, não o arquivo inteiro.
- **Uma auditoria por alteração.** Se `/reativa-one:checar` já rodou e o diff
  não mudou, o parecer vale.
- **Diff já lido não se reescreve na resposta**: cite `arquivo:linha`.
- **Consulta de diagnóstico:** uma por pergunta, e `count: 'exact', head: true`
  quando a pergunta é "quantos". Não traga mil linhas para contar — e **não
  reduza `MAX_MCP_OUTPUT_TOKENS` para economizar**: resultado truncado vira
  número errado, e número errado custa mais que o token que ele poupou.
- **Resposta:** o que mudou, onde, o que não foi verificado. Sem recontar o
  enunciado, sem repetir o diff, sem resumo do resumo.

## Antes de compactar ou limpar

- **Decisão vira arquivo no momento em que é tomada** — ledger, doc, PR —, não
  no fim da sessão.
- `PreCompact` e `SessionEnd` gravam um marco técnico em
  `.claude/reativa-one.marcos.local.md`: evento, branch, HEAD, escopo e
  contagem de arquivos alterados por área. É **rede, não fonte**: hook que
  estoura o timeout não roda, e o marco não guarda conteúdo — sem dado de
  aluno, sem valor, sem segredo, sem trecho de conversa.
