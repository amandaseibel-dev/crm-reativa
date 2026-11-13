# Republicação controlada das cinco funções ULBRA (correspondência exata de e-mail)

Documento da PR #945. **Nada foi publicado.** Este texto descreve o procedimento e as versões
que existem hoje em produção, para o caso de a republicação precisar ser revertida.

## 1. Versões em produção (conferido em 13/11/2026, somente leitura)

| função | versão | verify_jwt | fonte publicada guardada em |
|---|---|---|---|
| ulbra-atendimento | v5 | true | `rollback-ulbra-cinco-funcoes-prod/supabase/functions/ulbra-atendimento/` |
| ulbra-consultar | v8 | true | `.../ulbra-consultar/` (index, mcp, portao, vinculo) |
| ulbra-diagnostico | v2 | true | `.../ulbra-diagnostico/` |
| ulbra-leads-pendentes | v5 | true | `.../ulbra-leads-pendentes/index.ts` |
| ulbra-historico | v1 | true | `.../ulbra-historico/` e `.../ulbra-conversa/leitura.ts` |

Os hashes de cada arquivo estão em `rollback-ulbra-cinco-funcoes-prod/SHA256SUMS`. Conferir antes
de qualquer uso: `cd docs/integracoes/rollback-ulbra-cinco-funcoes-prod && shasum -a 256 -c SHA256SUMS`.

## 2. Divergência que precisa de decisão antes do deploy

**`ulbra-leads-pendentes` em produção não é a versão da `main`.** A versão publicada (v5) consulta
`usuarios` com `select("receptivo, gestao").limit(1).single()`, **sem filtro por e-mail**, e depende
da RLS para devolver a linha do próprio usuário. A versão da `main` é outra, com correspondência
por e-mail e portão próprio, e traz o aviso "SUPERADA ... NÃO USAR EM TELA NOVA".

Consequências:
- O deploy da versão desta PR **troca** o código em produção por um que não foi publicado antes.
  Isso precisa de decisão explícita da gestão, não de automação.
- O rollback da `ulbra-leads-pendentes` é a v5 de produção (pasta acima), **não** a da `main`.
- Antes do deploy, a gestão precisa decidir se a função de leads entra nesta republicação, fica
  como está, ou é retirada (retirar exige autorização própria).
- A RLS de `usuarios` que sustenta a v5 não foi conferida nesta rodada: **NÃO CONFERIDO**.

## 3. Procedimento controlado (só com autorização específica)

Pré-condições:
1. Parecer do Guardião favorável sobre o commit a publicar.
2. Testes e CI verdes no commit a publicar.
3. Decisão da gestão sobre `ulbra-leads-pendentes` (seção 2).
4. Hashes da seção 1 conferidos.

Passos:
1. Checkout limpo do commit aprovado. Não usar o checkout de trabalho.
2. Publicar cada função com o JWT obrigatório, sem `--no-verify-jwt`:
   `npx -y supabase@2.122.1 functions deploy <nome> --project-ref ahattpqrjmhkzsmnbdzs`
3. Conferir com `get_edge_function`: versão nova, `verify_jwt = true` e os hashes do commit aprovado.
4. Verificação sem consumir a API da ULBRA: chamada sem token deve dar 401 antes de qualquer
   consulta; chamada com JWT de usuário inativo deve dar 403.
5. Só então a navegação real, com a gestão.

## 4. Reversão

**`git revert` não basta para reverter produção.** Ele desfaz o código do repositório, mas não o
que está publicado. A reversão é outro deploy:
1. Restaurar as fontes da seção 1 a partir da pasta guardada, conferindo `SHA256SUMS`.
2. Publicar cada função com `functions deploy`, sem `--no-verify-jwt`.
3. Conferir versão, `verify_jwt` e hashes com `get_edge_function`.

Se a função não puder ser restaurada, a alternativa é retirá-la do projeto. A tela de Histórico
continua desligada, e a Central não depende das outras quatro.

## 5. O que não está coberto por este documento

- Nenhuma migration, grant ou RLS foi alterada ou conferida.
- Chamadas à API da ULBRA: nenhuma foi feita para preparar este documento.
- O modo como cada função se comporta com dados reais de produção não foi testado por execução.
