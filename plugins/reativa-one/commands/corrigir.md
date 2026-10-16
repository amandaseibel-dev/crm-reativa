---
description: Correção pontual com escopo declarado, testes do módulo e parada obrigatória quando a correção exigir regra nova no banco
---

Pedido: $ARGUMENTS

Delegue ao subagente `desenvolvedor`, com este contrato:

1. Antes da primeira edição, declarar o escopo por
   `bash "${CLAUDE_PLUGIN_ROOT}/scripts/escopo.sh" "<glob>" ...` — só os
   arquivos que a correção precisa.
2. Ler o que já existe antes de escrever (373 arquivos em `src/`, 100 telas: o
   helper provavelmente já existe).
3. Parar e devolver a decisão se a correção exigir regra nova — regra mora no
   banco, não em `.jsx` (Premissa 12). Nesta fase não há agente de Banco, e
   `supabase/migrations/` está bloqueado.
4. Rodar o teste do módulo, e `TZ=UTC` antes de empurrar qualquer teste que
   renderize data ou hora.
5. Encerrar dizendo o que ficou de fora e o que não foi verificado.
