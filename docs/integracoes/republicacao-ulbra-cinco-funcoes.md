# Republicação controlada das quatro funções ULBRA (correspondência exata de e-mail)

Documento da PR #945. **Nada foi publicado.** Este texto descreve o procedimento e as versões
de produção que precisam ser conferidas antes de qualquer republicação ou reversão.

Nome da pasta `rollback-ulbra-cinco-funcoes-prod/`: mantido por histórico. A pasta guarda as
**cinco** fontes publicadas, inclusive `ulbra-leads-pendentes`, que **não** faz parte desta
republicação.

## 1. Funções desta republicação e versões de produção

Esta PR altera **quatro** funções (ver `.github/workflows/ci.yml`, job de deno check):
`ulbra-atendimento`, `ulbra-consultar`, `ulbra-diagnostico` e `ulbra-historico`.

**Versões em produção: NÃO VERIFICADAS nesta revisão.** Nenhuma consulta a produção foi feita
para escrever este documento. Antes de qualquer uso, conferir com `get_edge_function` (somente
leitura) a versão, o `verify_jwt` e os hashes de cada função.

Hashes das fontes guardadas: `rollback-ulbra-cinco-funcoes-prod/SHA256SUMS`. Conferir com
`cd docs/integracoes/rollback-ulbra-cinco-funcoes-prod && shasum -a 256 -c SHA256SUMS`
(verificado nesta revisão: 12 de 12 arquivos OK). Hash confere com o arquivo, **não** com o que
está publicado em produção.

## 2. Fora desta republicação: `ulbra-leads-pendentes`

Decisão registrada no commit `cb1cae87`: a função **não** entra nesta PR, e a versão publicada
permanece. A versão da `main` é outra, com correspondência por e-mail e aviso "SUPERADA ... NÃO
USAR EM TELA NOVA". As duas divergem, e a versão de produção **não foi conferida** nesta revisão.

Consequências:
- A `main` ainda tem `.ilike("email", ...)` sem escape em `ulbra-leads-pendentes/index.ts`. Isso
  é risco conhecido e **não corrigido** aqui. Corrigir exige autorização própria da gestão.
- Nenhum deploy de `ulbra-leads-pendentes` pode sair do pacote desta PR.

## 3. Procedimento controlado (só com autorização específica)

Pré-condições:
1. Parecer do Guardião favorável sobre o commit a publicar.
2. Testes e CI verdes no commit a publicar.
3. Versões de produção da seção 1 conferidas com `get_edge_function` e registradas.
4. Hashes da seção 1 conferidos.

Passos:
1. Checkout limpo do commit aprovado. Não usar o checkout de trabalho.
2. Publicar cada uma das quatro funções com o JWT obrigatório, sem `--no-verify-jwt`:
   `npx -y supabase@2.122.1 functions deploy <nome> --project-ref ahattpqrjmhkzsmnbdzs`
3. Conferir com `get_edge_function`: versão nova, `verify_jwt = true` e os hashes do commit aprovado.
4. Verificação sem consumir a API da ULBRA: chamada sem token deve dar 401 antes de qualquer
   consulta; chamada com JWT de usuário inativo deve dar 403.
5. Só então a navegação real, com a gestão.

## 4. Reversão

**`git revert` não basta para reverter produção.** Ele desfaz o código do repositório, mas não o
que está publicado. A reversão é outro deploy:
1. Restaurar as fontes da pasta guardada, conferindo `SHA256SUMS`.
2. Publicar cada função com `functions deploy`, sem `--no-verify-jwt`.
3. Conferir versão, `verify_jwt` e hashes com `get_edge_function`.

Se a função não puder ser restaurada, a alternativa é retirá-la do projeto. A tela de Histórico
continua desligada, e a Central não depende de nenhuma das quatro funções para abrir.

## 5. O que não está coberto por este documento

- Nenhuma migration, grant ou RLS foi alterada ou conferida.
- Nenhuma consulta a produção foi feita para preparar este documento.
- Chamadas à API da ULBRA: nenhuma foi feita.
- O comportamento de cada função com dados reais de produção não foi testado por execução.
- A RLS de `usuarios` usada pelas funções não foi conferida nesta revisão.
