# CLAUDE.md

## Diretriz permanente — acelerador ReATIVA One

**Vale para TODAS as sessões e frentes deste repositório, sem precisar repetir
comando de aceleração.** Esta seção governa as demais; onde houver conflito
aparente, o item 2 diz como resolver.

1. usar proativamente os agentes, subagentes e skills **já configurados** —
   agentes [`desenvolvedor`](plugins/reativa-one/agents/desenvolvedor.md) (correção
   localizada, roda os testes do módulo) e
   [`guardiao`](plugins/reativa-one/agents/guardiao.md) (auditoria, devolve
   APROVADO/REPROVADO); skills `economia-de-tokens`, `fontes-de-verdade` e
   `seguranca-rls`; comandos `/ambiente`, `/autoteste`, `/checar`, `/corrigir`,
   `/escopo`, `/mapa`
2. delegar em paralelo as tarefas **independentes** — desenvolvimento, segurança
   financeira, testes e revisão. Paralelizar é o padrão quando uma tarefa não
   depende do resultado da outra; **quantos** agentes abrir continua saindo do
   critério da skill `economia-de-tokens` (ver "Economia de token" abaixo)
3. reutilizar diagnóstico, evidência e teste que já existem — `docs/`,
   `supabase/ledger/`, `supabase/tests/` e a skill `fontes-de-verdade`. Não
   repetir investigação ou auditoria já concluída e registrada
4. concentrar desenvolvimento, correção, teste e **commit local** numa única
   execução, dentro do escopo autorizado — não fatiar em idas e vindas
5. não criar agente nem skill novos sem necessidade comprovada e autorização
6. manter **um único executor** responsável por cada ação irreversível
7. nunca executar merge, migration, deploy, backfill ou alteração financeira sem
   autorização específica
8. responder de forma objetiva: resultado, testes, bloqueios **reais** e a
   próxima decisão necessária

**Evolução posterior desta diretriz.** Criar agente ou skill novos é possível
quando houver **ganho comprovado** e **nenhuma duplicação** do que já existe —
medido contra o inventário do item 1. O item 5 segue sendo a porta: a
necessidade é demonstrada antes, e a criação é autorizada, não presumida.

## Integração Prime/ULBRA

**ANTES DE QUALQUER ALTERAÇÃO, INVESTIGAÇÃO OU IMPLEMENTAÇÃO relacionada ao
Prime/ULBRA:**

1. abrir [`docs/integracoes/README.md`](docs/integracoes/README.md)
2. seguir obrigatoriamente o mapa de fontes de verdade e o catálogo documentado
3. não iniciar nova descoberta antes de verificar o que já está mapeado
4. não usar conversas ou memória como fonte primária
5. tratar `docs/integracoes/` como fonte oficial versionada da integração

## Economia de token

1. priorizar o menor consumo que preserve qualidade, segurança e precisão
2. antes de abrir subagente, varrer arquivo inteiro ou subir de modelo, seguir
   a skill `economia-de-tokens` do plugin ReATIVA One — critério objetivo de
   modelo, esforço e número de agentes
3. subir de modelo ou de esforço exige declarar, em uma linha, qual critério
   acionou
