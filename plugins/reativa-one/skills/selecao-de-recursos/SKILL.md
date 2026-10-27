---
name: selecao-de-recursos
description: Diz QUAL recurso do ReATIVA One usar em cada tarefa — agente, skill, comando, subagente de varredura ou a própria sessão —, o que pode rodar em paralelo e quem tem a caneta em cada arquivo. Use ao receber qualquer pedido que vá tocar mais de um arquivo, antes de abrir subagente e antes de rodar duas frentes ao mesmo tempo.
---

# Qual recurso usar nesta tarefa

Esta skill **não contém regra de negócio** e **não repete política de custo**.
Divisão de trabalho entre as três skills:

| Pergunta | Skill |
|---|---|
| *Qual arquivo manda neste assunto?* | `fontes-de-verdade` |
| *Quanto gastar — modelo, esforço, quantos agentes?* | `economia-de-tokens` |
| *Qual recurso faz este trabalho, e o que roda junto?* | **esta** |

As três se encadeiam: primeiro **o que** (roteador), depois **quem** (esta),
depois **quanto** (custo). Pular a primeira produz regra reescrita de memória;
pular esta produz a sessão principal fazendo à mão o que um comando já faz.

---

## Roteador de recursos

| O pedido é… | Use | Por que não a sessão principal |
|---|---|---|
| "qual é a regra de X?", "onde fica Y?" | `/reativa-one:mapa` | o comando abre **só o trecho** que importa; a sessão tende a ler o arquivo inteiro |
| "estamos em PROD ou staging?", "os freios estão de pé?" | `/reativa-one:ambiente` | `config.toml` **não** diz o destino — o `project_id` dele é local |
| "corrija esta tela", "ajuste este utilitário", "este botão não faz X" | agente `desenvolvedor` (ou `/reativa-one:corrigir`) | ele **declara escopo** antes de editar, e para quando a correção exigir regra nova no banco |
| "isto está pronto para PR?", "isto amplia acesso?" | agente `guardiao` (ou `/reativa-one:checar`) | o Guardião não tem Edit/Write de propósito: quem audita não conserta |
| "onde mais existe esta fórmula/este padrão?" | subagente `Explore` | varredura ampla da qual se quer **só a conclusão**, não o despejo dos arquivos |
| "os bloqueios ainda funcionam?" | `/reativa-one:autoteste` | 75 casos, nenhum executado contra produção |
| declarar/ver os arquivos que a frente pode tocar | `/reativa-one:escopo` | é o que impede correção de tela virar alteração em módulo que ninguém pediu |
| conferir se arquivo, linha ou função existe | **aqui**, `rg -n` / `sed -n 'A,Bp'` | cabe em uma chamada; agente para isso é desperdício puro |

**Quando nada acima encaixa, o trabalho é da sessão principal.** Recurso que
não existe não se inventa no meio da tarefa: ver "Lacuna" no fim.

---

## A sessão principal coordena — e o que isso proíbe

A sessão principal **decide, roteia, integra e responde**. Ela é a única que
fala com a gestão e a única que guarda o fio da frente inteira.

Ela **não** delega:

- a decisão de **o que** fazer, nem o recorte do escopo;
- a leitura de algo que **já está no contexto** — reler é custo sem informação;
- a resposta final e o que nela fica declarado como não verificado;
- **migration, merge, deploy, backfill e alteração financeira**: exigem
  autorização específica e **executor único**, e esse executor é a sessão
  principal, nunca um subagente. Subagente não tem como receber autorização da
  gestão — ele recebe um prompt.

Ela **delega** varredura ampla, correção localizada com escopo declarado e
auditoria de diff. Nada mais.

---

## Paralelismo: a condição, não a vontade

Duas frentes rodam juntas **só quando as quatro valem ao mesmo tempo**:

1. nenhuma lê o resultado da outra;
2. nenhuma depende de alteração que a outra ainda vai fazer;
3. **nenhuma escreve nos mesmos arquivos** que a outra;
4. nenhuma precisa entrar junto com a outra na mesma alteração.

Falhou uma? **Sequencial.** Duas frentes em paralelo sobre o mesmo arquivo não
dão conflito de merge — dão sobrescrita silenciosa, que é pior, porque ninguém
vê.

Chamadas de **leitura** independentes (ler dois arquivos, rodar duas consultas
de diagnóstico, uma varredura e um teste) vão **na mesma mensagem**, em
paralelo: não há caneta envolvida, e esperar uma para pedir a outra é um
ida-e-volta jogado fora.

### Quem tem a caneta

| Situação | Quem escreve |
|---|---|
| frente única | a sessão principal, **ou** um `desenvolvedor` — nunca os dois no mesmo arquivo |
| duas frentes em arquivos disjuntos | um `desenvolvedor` por frente, **cada um com seu `escopo` declarado** |
| duas frentes que tocariam o mesmo arquivo | **uma só**, sequencial |
| auditoria concomitante à correção | o `guardiao` **não escreve** — pode rodar junto com segurança |

`/reativa-one:escopo` é o que torna isso verificável: o Guardião (Camada 1)
recusa Edit/Write fora do escopo declarado. Escopo declarado largo demais
("`src/**`") devolve a proteção a zero — declare os arquivos, não a árvore.

---

## Não repetir o que já foi decidido

Antes de abrir frente nova, confira se a resposta já existe — nesta ordem, e
pare na primeira que responder:

1. `supabase/ledger/` + `INDICE.tsv` — o que **de fato** rodou em produção;
   md5 byte a byte é a prova, e o ledger não se edita;
2. `docs/` pelo roteador da skill `fontes-de-verdade` — a decisão e a medição;
3. `docs/BACKLOG-TECNICO.md` — "não implementar sem aprovação" vale;
4. o PR anterior do mesmo assunto, pelo histórico.

**Diagnóstico já feito não se refaz.** Se `/reativa-one:checar` já rodou e o
diff não mudou, o parecer vale. Se um número já foi provado e está em arquivo,
cite `arquivo:linha` — não reconte a consulta.

E o que nunca conta como fonte: conversa anterior, memória de sessão e
`config.toml`. Os três já produziram afirmação errada neste repositório.

---

## Lacuna: o recurso que não existe

Não há, nesta fase, agente de **Banco**, de **Entrega** nem de **conciliação
financeira** — são Fase 2 e dependem de autorização separada. Consequência
prática: quando a tarefa exige regra nova no banco, prova de causa em dado de
produção ou fechamento de valor, **a sessão principal faz, com o modelo da
sessão**, e o `guardiao` audita depois. Não se improvisa um subagente genérico
para isso: subagente sem as fontes carregadas conclui por aproximação, e valor
financeiro por aproximação é exatamente o erro que este repositório mais pagou.
