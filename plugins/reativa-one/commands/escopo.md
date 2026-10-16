---
description: Declara (ou mostra) os arquivos que esta frente pode editar — o Guardião recusa Edit/Write fora disso
allowed-tools: ["Bash"]
---

Argumento: um ou mais globs relativos à raiz do repositório. Sem argumento,
mostra o escopo atual.

```
bash "${CLAUDE_PLUGIN_ROOT}/scripts/escopo.sh" $ARGUMENTS
```

Depois, confirme em uma linha o que ficou declarado. Se o pedido do usuário
precisar de arquivo fora do escopo, **não amplie por conta própria**: diga qual
arquivo falta e por quê, e deixe a decisão com ele.
