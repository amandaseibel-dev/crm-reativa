---
description: Diz qual arquivo do repositório manda no assunto pedido, e abre só o trecho que importa
allowed-tools: ["Read", "Grep", "Glob"]
model: sonnet
effort: low
---

Assunto: $ARGUMENTS

Use a skill `fontes-de-verdade` para localizar a fonte oficial do assunto, abra
**o trecho** que responde (não o arquivo inteiro) e responda citando arquivo e
seção.

Regras desta resposta:

- Se o assunto envolver Prime/ULBRA, o `CLAUDE.md` obriga a abrir
  `docs/integracoes/README.md` primeiro e seguir os 6 passos de lá.
- Não inicie descoberta nova sem antes conferir o que já está mapeado.
- Se a fonte não existir, diga que não existe — não preencha com memória.
