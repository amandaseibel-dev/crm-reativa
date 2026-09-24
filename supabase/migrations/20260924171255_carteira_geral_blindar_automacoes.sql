-- ---------------------------------------------------------------------------
-- CARTEIRA GERAL — blindagem das rotinas automaticas
--
-- O PROBLEMA QUE ISTO RESOLVE
-- Recolher uma carteira nao adianta se a maquina devolver tudo sozinha.
-- Levantamento de 24/09/2026 sobre a definicao viva das rotinas:
--
--  (a) nivelamento_automatico_gestao — cron ATIVO, 09:20 todo dia.
--      Distribui a base da gestao para `usuarios where ativo and perfil='operador'`.
--      Se a carteira da Olga for recolhida hoje, amanha as 09:20 ela volta a
--      receber casos. E exatamente o "devolver os casos a Olga" que nao pode
--      acontecer.
--
--  (b) reforcar_teto_operadores e nivelar_medias_progressivo agrupam por
--      QUALQUER `operador_email` nao nulo (menos a Amanda gestora). Isso inclui
--      juridico@ (58 casos, media zero, puxando a media da equipe para baixo) e
--      incluiria a propria Carteira Geral: passando de 500 casos, o reforco de
--      teto soltaria a Carteira Geral inteira para a fila livre.
--
--  (c) reposicao_carteira_processar repoe ate 500 para quem fecha um caso.
--      Sem um interruptor, repor e outra porta de volta.
--
--  (c2) E a porta mais larga de todas: `assumir_caso_livre` e irmas. Nenhuma
--      distribuicao precisa acontecer para a carteira voltar — basta a propria
--      pessoa clicar em "assumir" na fila livre. Recolher a carteira de alguem
--      e deixar essa porta aberta e teatro.
--
--  (d) atribuir_responsavel_por_acordo dispara notificacao a cada troca de dono
--      de acordo. Recolher a carteira da Olga geraria ~356 notificacoes para uma
--      caixa que nao existe.
--
-- COMO O PATCH E FEITO
-- Nao reescrevemos o corpo destas funcoes a mao. Este repositorio tem drift
-- conhecido entre migrations e banco (ver docs/RUNBOOK-MIGRATIONS.md), e
-- retypar 200 linhas com regex e escape e a forma mais facil de introduzir bug
-- silencioso. Cada bloco abaixo LE a definicao viva (pg_get_functiondef),
-- exige a ancora exata na contagem exata e troca so aquele trecho. Se a ancora
-- nao estiver la, a migration FALHA — nao aplica pela metade.
-- ---------------------------------------------------------------------------

-- Utilitario local: aplica um patch ancorado e verifica a contagem.
create or replace function internal.patch_funcao_ancorada(
  p_schema text, p_funcao text, p_ancora text, p_novo text, p_ocorrencias int
) returns void
language plpgsql
as $fn$
declare v_src text; v_n int; v_ja int;
begin
  -- Patch ambiguo: se o texto novo e um PEDACO da ancora, ele ja aparece na
  -- funcao antes de qualquer troca e nao da para distinguir "ja aplicado" de
  -- "nunca aplicado". Recusa na entrada em vez de errar em silencio.
  if position(p_novo in p_ancora) > 0 and position(p_ancora in p_novo) = 0 then
    raise exception 'patch_funcao_ancorada: o texto novo e pedaco da ancora — patch ambiguo, reescreva a ancora.';
  end if;

  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = p_schema and p.proname = p_funcao
   limit 1;

  if v_src is null then
    raise exception 'patch_funcao_ancorada: %.% nao existe.', p_schema, p_funcao;
  end if;

  -- Idempotencia ANTES da contagem da ancora. Nos patches que so ACRESCENTAM
  -- (o texto novo contem a ancora), a ancora continua existindo depois de
  -- aplicado — entao contar ancora nao distingue nada. O que distingue e o
  -- texto NOVO ja estar la.
  v_ja := (length(v_src) - length(replace(v_src, p_novo, ''))) / length(p_novo);
  if v_ja >= p_ocorrencias then
    raise notice 'patch_funcao_ancorada: %.% ja estava aplicada.', p_schema, p_funcao;
    return;
  end if;

  v_n := (length(v_src) - length(replace(v_src, p_ancora, ''))) / length(p_ancora);
  if v_n <> p_ocorrencias then
    raise exception 'patch_funcao_ancorada: %.% tem % ocorrencia(s) da ancora, esperado %. A funcao mudou; revise o patch.',
      p_schema, p_funcao, v_n, p_ocorrencias;
  end if;

  execute replace(v_src, p_ancora, p_novo);
end;
$fn$;

comment on function internal.patch_funcao_ancorada(text,text,text,text,int) is
  'Troca um trecho exato da definicao viva de uma funcao, preservando o resto byte a byte. Falha se a ancora nao bater.';

revoke all on function internal.patch_funcao_ancorada(text,text,text,text,int) from public, anon, authenticated;

do $patch$
begin

  -- (a) A rotina das 09:20 so entrega a quem esta recebendo distribuicao. ----
  perform internal.patch_funcao_ancorada(
    'public', 'nivelamento_automatico_gestao',
    'where u.ativo and u.perfil = ''operador'' and not (u.email = any(p_origens));',
    'where u.ativo and u.perfil = ''operador'' and coalesce(u.recebe_novos_casos, true) and not (u.email = any(p_origens));',
    1);

  -- (a2) A calibragem que a gestao roda na tela usa a mesma regra, para que a
  -- simulacao mostre a verdade e nao proponha devolver casos a quem foi
  -- recolhido.
  perform internal.patch_funcao_ancorada(
    'public', 'calibragem_simular_nivelamento_impl',
    'where u.ativo and u.perfil = ''operador''',
    'where u.ativo and u.perfil = ''operador'' and coalesce(u.recebe_novos_casos, true)',
    1);

  -- (b) Teto e nivelamento por media so olham OPERADOR ATIVO de verdade.
  -- Efeito colateral bem-vindo: juridico@ (58 casos, saldo zero) sai da media.
  perform internal.patch_funcao_ancorada(
    'public', 'reforcar_teto_operadores',
    'WHERE operador_email IS NOT NULL AND operador_email <> ''amanda.seibel@aelbra.com.br''',
    'WHERE operador_email IS NOT NULL AND operador_email <> ''amanda.seibel@aelbra.com.br'''
      || ' AND EXISTS (SELECT 1 FROM public.usuarios u WHERE lower(u.email) = lower(casos.operador_email) AND u.ativo AND u.perfil = ''operador'')',
    1);

  perform internal.patch_funcao_ancorada(
    'public', 'nivelar_medias_progressivo',
    'FROM public.casos WHERE operador_email IS NOT NULL AND operador_email <> ''amanda.seibel@aelbra.com.br''',
    'FROM public.casos WHERE operador_email IS NOT NULL AND operador_email <> ''amanda.seibel@aelbra.com.br'''
      || ' AND EXISTS (SELECT 1 FROM public.usuarios u WHERE lower(u.email) = lower(casos.operador_email) AND u.ativo AND u.perfil = ''operador'')',
    2);

  -- (c) Reposicao respeita o interruptor.
  perform internal.patch_funcao_ancorada(
    'public', 'reposicao_carteira_processar',
    'where u.email = ped.operador_email and u.perfil = ''operador'' and u.ativo = true) then',
    'where u.email = ped.operador_email and u.perfil = ''operador'' and u.ativo = true and coalesce(u.recebe_novos_casos, true)) then',
    1);

  perform internal.patch_funcao_ancorada(
    'public', 'reposicao_carteira_processar',
    'erro = ''operador nao esta mais ativo''',
    'erro = ''operador inativo ou fora da entrada de casos novos''',
    1);

  -- (c2) As quatro portas de auto-atribuicao passam pelo mesmo flag. A regra
  -- mora em internal.operador_recebe_novos_casos() -- uma leitura so, para nao
  -- existirem quatro versoes dela. Nenhuma delas ganha permissao nova: o que
  -- muda e que o operador desligado recebe a mesma recusa que ja recebia
  -- quando nao era operador ativo.
  --
  -- Fica de fora, de proposito, `sistema_assumir_receptivo`: ali o aluno esta
  -- no telefone. Recusar o atendimento receptivo por causa de um interruptor
  -- de carteira deixaria a pessoa sem quem a atendesse.
  perform internal.patch_funcao_ancorada(
    'public', 'assumir_caso_livre',
    'if v_nome is null then return query select false,''Operador nao ativo ou nao identificado.'',null::uuid; return; end if;',
    'if v_nome is null then return query select false,''Operador nao ativo ou nao identificado.'',null::uuid; return; end if;'
      || E'\n  if not internal.operador_recebe_novos_casos(v_email) then return query select false,''Sua carteira esta fechada para casos novos. Fale com a gestao.'',null::uuid; return; end if;',
    1);

  perform internal.patch_funcao_ancorada(
    'public', 'assumir_caso_livre_aluno',
    'if v_nome is null then return query select false,''Operador nao ativo.'',null::uuid,null::uuid; return; end if;',
    'if v_nome is null then return query select false,''Operador nao ativo.'',null::uuid,null::uuid; return; end if;'
      || E'\n  if not internal.operador_recebe_novos_casos(v_email) then return query select false,''Sua carteira esta fechada para casos novos. Fale com a gestao.'',null::uuid,null::uuid; return; end if;',
    1);

  perform internal.patch_funcao_ancorada(
    'public', 'sistema_assumir_atendimento',
    'if v_nome is null then return jsonb_build_object(''ok'',false,''erro'',''NAO_E_OPERADOR_ATIVO''); end if;',
    'if v_nome is null then return jsonb_build_object(''ok'',false,''erro'',''NAO_E_OPERADOR_ATIVO''); end if;'
      || E'\n  if not internal.operador_recebe_novos_casos(v_email) then return jsonb_build_object(''ok'',false,''erro'',''CARTEIRA_FECHADA_PARA_NOVOS'',''mensagem'',''Sua carteira esta fechada para casos novos. Fale com a gestao.''); end if;',
    1);

  perform internal.patch_funcao_ancorada(
    'public', 'assumir_atendimento_aluno',
    'v_nome := public.nome_operador_por_email(v_email);',
    'v_nome := public.nome_operador_por_email(v_email);'
      || E'\n  if not internal.operador_recebe_novos_casos(v_email) then return query select false, ''Sua carteira esta fechada para casos novos. Fale com a gestao.''; return; end if;',
    1);

  -- (d) Sem notificacao para a caixa da Carteira Geral, que nao existe.
  perform internal.patch_funcao_ancorada(
    'public', 'atribuir_responsavel_por_acordo',
    'if coalesce(new.operador_responsavel_email,'''') = '''' then return new; end if;',
    'if coalesce(new.operador_responsavel_email,'''') = '''' then return new; end if;'
      || E'\n  if lower(new.operador_responsavel_email) = internal.carteira_geral_email() then return new; end if;',
    1);

end;
$patch$;

-- Todas as funcoes tocadas passaram a chamar algo do schema `internal`:
-- garante o search_path de cada uma. (assumir_caso_livre_aluno e
-- sistema_assumir_atendimento ja o tinham; repetir e inofensivo e deixa a
-- lista completa para quem ler depois.)
alter function public.atribuir_responsavel_por_acordo() set search_path to 'public', 'internal';
alter function public.assumir_caso_livre(uuid) set search_path to 'public', 'internal';
alter function public.assumir_caso_livre_aluno(uuid) set search_path to 'public', 'internal';
alter function public.sistema_assumir_atendimento(uuid) set search_path to 'public', 'internal';
alter function public.assumir_atendimento_aluno(text, text) set search_path to 'public', 'internal';

-- ---------------------------------------------------------------------------
-- Vigia: uma consulta que responde "a Carteira Geral vazou?".
-- Use depois de qualquer rodada de calibragem. Zero = nada vazou.
-- ---------------------------------------------------------------------------
create or replace function public.carteira_geral_vigia()
returns jsonb
language sql
stable
security definer
set search_path to 'public', 'internal'
as $fn$
  select jsonb_build_object(
    'na_carteira_geral', (select count(*) from public.casos
                           where lower(coalesce(operador_email,'')) = internal.carteira_geral_email()),
    'acordos_na_carteira_geral', (select count(*) from public.acordos
                                   where lower(coalesce(operador_responsavel_email,'')) = internal.carteira_geral_email()),
    'operadores_sem_entrada_de_casos', (select coalesce(jsonb_agg(nome order by nome), '[]'::jsonb)
                                      from public.usuarios
                                     where perfil = 'operador' and ativo
                                       and not coalesce(recebe_novos_casos, true)),
    -- casos que sairam da Carteira Geral sem passar por carteira_geral_mover:
    -- a auditoria registra toda saida legitima.
    'saidas_sem_auditoria', (
      select count(*) from public.historico_operadores_alunos h
       where h.operador_anterior_email = internal.carteira_geral_email()
         and not exists (select 1 from public.carteira_geral_auditoria a
                          where a.aluno_id = h.aluno_id and a.registrado_em between h.criado_em - interval '1 minute' and h.criado_em + interval '1 minute'))
  );
$fn$;

revoke all on function public.carteira_geral_vigia() from public, anon;
grant execute on function public.carteira_geral_vigia() to authenticated;
