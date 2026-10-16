---
description: Roda o autoteste dos bloqueios do Guardião (63 casos, nenhum executado contra produção) e apresenta o resultado
allowed-tools: ["Bash"]
---

```
node plugins/reativa-one/tests/guardiao.autoteste.mjs
```

Para o relatório em tabela, acrescente `--md`.

Apresente: total de casos, quantos de bloqueio, quantos como esperado e os
divergentes por id. Nenhuma linha de comando testada é executada — elas
atravessam o avaliador, não o shell.

Lembre em uma linha: este autoteste prova a **Camada 1** (o hook). Que o
`deny`/`ask` de `.claude/settings.json` esteja ativo é a **Camada 0**, provada
pelas sentinelas descritas no README — e que o hook esteja carregado só se
prova com o plugin instalado.
