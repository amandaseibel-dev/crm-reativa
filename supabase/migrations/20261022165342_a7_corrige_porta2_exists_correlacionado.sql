-- A7 — CORRECAO DE INCIDENTE: a porta 2 ficou inutilizavel.
--
-- O QUE ACONTECEU. A migration 20261022164045 (A7) poe a guarda de contato
-- compartilhado nas duas portas de envio. Na porta 1
-- (`acoes_massivas_universo`) a guarda entrou como LEFT JOIN e custou +1,8 s
-- sobre ~8 s -- dentro do previsto. Na porta 2
-- (`buscar_candidatos_acoes_massivas`, da tela Envio Gmail em lote) ela entrou
-- como DOIS `EXISTS` CORRELACIONADOS, reavaliados por linha. `vw_contato_bloqueio`
-- custa ~916 ms por leitura, entao cada linha pagava ~1,44 s:
--
--   medido em producao em 22/10/2026, logo depois de aplicar:
--   `buscar_candidatos_acoes_massivas(null, 50, null, false)` = 72.097 ms
--
-- A tela pede 300 registros. Isso daria ~7 minutos e estoura o timeout: o
-- operador nao via fila nenhuma. Ultimo e-mail enviado 16:41:05, vinte segundos
-- depois da aplicacao (de uma lista carregada ANTES), e nada depois.
--
-- O aviso contra `EXISTS` correlacionado estava escrito na propria migration do
-- A7 -- "neste banco um EXISTS correlacionado dentro de CTE materializado ja
-- custou 35 s" -- e foi desrespeitado exatamente na porta 2. A correcao usa o
-- mesmo padrao que funciona na porta 1.
--
-- O QUE ESTA CORRECAO NAO MUDA: a selecao, os bloqueios e os motivos ficam
-- identicos. Nenhuma ficha entra ou sai do universo por causa dela -- o que
-- muda e so COMO a mesma condicao e avaliada. Zero DML, nenhum valor, saldo,
-- acordo, pagamento, baixa, responsavel ou contato tocado.

-- ---------------------------------------------------------------------------
-- 1. UMA leitura da view, agregada por aluno, unida por hash
-- ---------------------------------------------------------------------------
-- (1.a) o SELECT e o FROM: troca o EXISTS do telefone e acrescenta o join.
select internal.patch_funcao_ancorada(
  'public', 'buscar_candidatos_acoes_massivas',
$ancora$  SELECT a.id, a.nome,
         -- A7: telefone bloqueado nao sai desta funcao.
         CASE WHEN EXISTS (SELECT 1 FROM public.vw_contato_bloqueio b
                            WHERE b.aluno_id = a.id AND b.canal = 'TELEFONE')
              THEN NULL ELSE a.telefone END,
         a.email, a.data_ultimo_acionamento,
         COALESCE(c.total_em_aberto, 0) AS valor
  FROM public.alunos a
  LEFT JOIN public.casos c ON c.aluno_id = a.id AND c.operador_email IS NULL$ancora$,
$novo$  SELECT a.id, a.nome,
         -- A7: telefone bloqueado nao sai desta funcao.
         CASE WHEN coalesce(bl.tel_bloqueado, false) THEN NULL ELSE a.telefone END,
         a.email, a.data_ultimo_acionamento,
         COALESCE(c.total_em_aberto, 0) AS valor
  FROM public.alunos a
  LEFT JOIN public.casos c ON c.aluno_id = a.id AND c.operador_email IS NULL
  -- A7 CORRECAO DO INCIDENTE: UMA leitura de vw_contato_bloqueio, agregada por
  -- aluno e unida por hash -- em vez de dois EXISTS correlacionados por linha.
  LEFT JOIN (
    select b.aluno_id,
           bool_or(b.canal = 'TELEFONE') as tel_bloqueado,
           bool_or(b.canal = 'EMAIL')    as email_bloqueado
      from public.vw_contato_bloqueio b
     group by b.aluno_id
  ) bl ON bl.aluno_id = a.id$novo$,
  1);

-- (1.b) o WHERE: troca o NOT EXISTS do e-mail.
--
-- `coalesce(..., false)` de proposito: sem linha na view o canal esta LIVRE.
-- Com `NOT bl.email_bloqueado` cru, a ausencia de linha daria NULL, a condicao
-- viraria NULL e a ficha desapareceria em silencio -- o oposto do pretendido.
select internal.patch_funcao_ancorada(
  'public', 'buscar_candidatos_acoes_massivas',
$ancora$    -- A7: segunda porta. Esta tela envia E-MAIL pelo Gmail do operador.
    AND NOT EXISTS (
      SELECT 1 FROM public.vw_contato_bloqueio b
       WHERE b.aluno_id = a.id AND b.canal = 'EMAIL'
    )$ancora$,
$novo$    -- A7: segunda porta. Esta tela envia E-MAIL pelo Gmail do operador.
    AND NOT coalesce(bl.email_bloqueado, false)$novo$,
  1);

-- ---------------------------------------------------------------------------
-- 2. GUARDA DE INTEGRIDADE
-- ---------------------------------------------------------------------------
-- A ancora ja falha fechado se o corpo tiver mudado. Isto confere o RESULTADO:
-- o EXISTS correlacionado tem de ter desaparecido, e o bloqueio por canal tem
-- de continuar no corpo. Se qualquer um dos dois falhar, a transacao inteira
-- volta -- inclusive os revokes da secao 3.
do $guarda$
declare
  v_src text;
begin
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'buscar_candidatos_acoes_massivas';

  if v_src is null then
    raise exception 'A7 correcao: buscar_candidatos_acoes_massivas nao existe.';
  end if;

  if position('EXISTS (SELECT 1 FROM public.vw_contato_bloqueio' in v_src) > 0 then
    raise exception 'A7 correcao: sobrou EXISTS correlacionado contra vw_contato_bloqueio -- a causa do incidente nao foi removida.';
  end if;

  if position('tel_bloqueado' in v_src) = 0 or position('email_bloqueado' in v_src) = 0 then
    raise exception 'A7 correcao: o bloqueio por canal saiu do corpo da funcao -- a protecao teria sido perdida.';
  end if;

  if position('vw_contato_bloqueio' in v_src) = 0 then
    raise exception 'A7 correcao: a funcao nao le mais vw_contato_bloqueio.';
  end if;
end
$guarda$;

-- ---------------------------------------------------------------------------
-- 3. GRANTS INDEVIDOS DAS DUAS FUNCOES PURAS
-- ---------------------------------------------------------------------------
-- Divergencia encontrada na conferencia pos-aplicacao: `contato_e_placeholder`
-- e `contato_tel_sem_ddi` ficaram executaveis por `authenticated`. O
-- `revoke ... from public` da migration do A7 nao cobriu isso, porque o grant
-- nao vem de PUBLIC: vem do DEFAULT PRIVILEGE do schema, que concede EXECUTE
-- direto a `authenticated` para toda funcao nova.
--
-- Nao houve exposicao de dado: as duas sao IMMUTABLE, recebem o valor por
-- argumento e NAO leem tabela nenhuma. `anon` nunca as alcancou. Mesmo assim
-- sao plumbing interno e nao devem estar publicadas no PostgREST.
--
-- `contato_fila_revisao` e `usuario_pode_revalidar_contato` NAO sao tocadas:
-- a tela de revisao cadastral e a ficha do aluno dependem delas.
revoke execute on function public.contato_e_placeholder(text, text) from authenticated, anon;
revoke execute on function public.contato_tel_sem_ddi(text) from authenticated, anon;

do $g2$
begin
  if has_function_privilege('authenticated', 'public.contato_e_placeholder(text,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.contato_tel_sem_ddi(text)', 'EXECUTE') then
    raise exception 'A7 correcao: o revoke do plumbing nao pegou.';
  end if;
  if not has_function_privilege('authenticated', 'public.contato_fila_revisao(text,integer)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.usuario_pode_revalidar_contato()', 'EXECUTE') then
    raise exception 'A7 correcao: revoguei funcao que a operacao precisa.';
  end if;
end
$g2$;
