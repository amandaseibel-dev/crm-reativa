-- P1 · CRÍTICA: fecha o acesso SEM LOGIN à situação jurídica por CPF.
--
-- O QUE ESTÁ ABERTO, MEDIDO EM 20/10/2026
--
-- `public.prime_aluno_no_juridico(p_cpf text)` e SECURITY DEFINER, recebe um CPF
-- e devolve 'SIM' / 'NAO' / 'INDETERMINADO' lendo `prime_portador_membro` no
-- portador 202 (REATIVA COBRANCA JUDICIAL). Os grants em producao:
--
--   PUBLIC=EXECUTE, authenticated=EXECUTE, postgres=EXECUTE, service_role=EXECUTE
--
-- A CAUSA RAIZ NAO E UM GRANT A `anon`: e o `EXECUTE` para **PUBLIC**, que toda
-- funcao nova herda do Postgres. `anon` alcanca por PUBLIC, e o PostgREST expoe
-- a rota `/rest/v1/rpc/prime_aluno_no_juridico`. Resultado: qualquer pessoa com
-- a chave publicavel do front -- que viaja no bundle, por desenho -- pergunta
-- por CPF se um aluno esta na cobranca judicial, **sem fazer login**. Hoje sao
-- 72 CPFs no portador 202 que responderiam 'SIM', e o parametro e enumeravel.
--
-- Dado pessoal sensivel, exposto sem autenticacao. E a lacuna P1 da secao 23 do
-- Plano Diretor, classificada como critica pela gestao.
--
-- NADA LEGITIMO DEPENDE DO ACESSO ANONIMO -- CONFERIDO, NAO SUPOSTO
--
--  * `git grep prime_aluno_no_juridico` em src/, supabase/functions/ e
--    supabase/migrations/ na main: **zero** ocorrencias de chamada;
--  * nenhuma funcao de `public` ou `internal` cita a funcao no corpo (zero);
--  * nenhuma view ou matview a usa (zero);
--  * a funcao tem **uma** assinatura, sem sobrecarga que ficasse aberta;
--  * o front cria o cliente com a chave publicavel, mas as chamadas da tela vao
--    com a sessao -- ou seja, no papel `authenticated`, que **continua tendo
--    acesso**. Edge Function usa `service_role`, que tambem continua.
--
-- Portanto: revogar de PUBLIC/anon nao quebra caminho de usuario nenhum.
--
-- NAO HA CAMINHO EQUIVALENTE PARA O MESMO DADO -- CONFERIDO
--
--  * tabelas e views legiveis por `anon` no schema `public`: **zero** (nem
--    `prime_portador_membro`, nem view sobre ela);
--  * nenhuma outra RPC alcancavel por `anon` recebe CPF como parametro;
--  * nenhuma view alcancavel por `anon` menciona JURIDICO.
--
-- Fica declarado o que esta correcao NAO cobre, e que segue na sequencia de
-- seguranca: `prime_portador_snapshot_estado(integer,integer)` continua
-- alcancavel por `anon` (P5). Ela **nao** responde por CPF -- devolve o estado
-- do snapshot do portador (validade e idade) -- entao nao e caminho equivalente
-- para situacao juridica individual; mas expoe metadado de coleta e sai no mesmo
-- lote de `revoke` da P5.
--
-- O QUE MUDA: SO PRIVILEGIO
--
-- Nenhuma linha do corpo da funcao e tocada. `md5(prosrc)` em producao antes
-- desta migration: 7066bc7660854bf34ac45b95b032f65b -- e tem de continuar o
-- mesmo depois. Nenhuma tabela, nenhum gatilho, nenhum dado, nenhum agendamento.
--
-- Padrao da casa respeitado: **restringir e portao interno ou revoke de PUBLIC e
-- anon, nunca revoke de `authenticated`** -- revogar de authenticated derrubaria
-- a tela para a propria gestao, erro ja cometido e registrado.
--
-- Reversivel: supabase/rollbacks/20261020223151_*.rollback.sql

-- Fecha PUBLIC (a heranca) e anon (o papel sem login) de forma explicita. Os
-- dois: PUBLIC porque e de onde vem o acesso, e anon por clareza de intencao --
-- se amanha alguem reconceder a PUBLIC, o revoke de anon nao salva, e e por isso
-- que o teste cobre os dois.
revoke all on function public.prime_aluno_no_juridico(text) from public;
revoke all on function public.prime_aluno_no_juridico(text) from anon;

-- Reafirma quem PRECISA continuar consultando. Idempotente: os dois ja tinham
-- EXECUTE; declarar aqui deixa a intencao no arquivo, em vez de depender de
-- heranca.
grant execute on function public.prime_aluno_no_juridico(text) to authenticated;
grant execute on function public.prime_aluno_no_juridico(text) to service_role;

comment on function public.prime_aluno_no_juridico(text) is
  'Responde se o CPF esta na cobranca judicial (portador 202): SIM / NAO / '
  'INDETERMINADO. DADO PESSOAL SENSIVEL -- EXECUTE fechado para PUBLIC e anon em '
  '20/10/2026 (P1 da seguranca em camadas); so authenticated e service_role '
  'alcancam. Restringir mais que isso e portao interno, nunca revoke de '
  'authenticated.';
