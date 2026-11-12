-- ROLLBACK de 20261112210000_fidelizacao_giro_segue_os_10_dias
--
-- O QUE REVERTER REINTRODUZ, EM LETRAS MAIÚSCULAS:
--
--   O CASO COM MARCA DE GIRO VOLTA A NUNCA SER SOLTO PELA FIDELIZAÇÃO DE 10
--   DIAS NEM PELO TETO; OUTRO OPERADOR VOLTA A PODER ASSUMIR CASO DE GIRO
--   ACIONADO ONTEM; E `liberar_fidelizacao_caso` VOLTA A NÃO CONFERIR QUEM CHAMA;
--   E O CARD "RISCO DE PERDER" (`casos_risco_perder`) VOLTA A LISTAR CASO DE
--   GIRO VIGENTE E CASO COM RETORNO AGENDADO PELO OPERADOR.
--
-- O QUE ESTE ROLLBACK NÃO FAZ: não devolve ao operador os casos que a rotina
-- diária já tiver soltado depois da aplicação. Devolução é DML, exige lista por
-- id tirada de `historico_operadores_alunos` (acao = 'FIDELIZACAO_EXPIRADA',
-- criado_em >= data da aplicação) e autorização própria.
--
-- Reversão BYTE A BYTE: troca cada texto novo pelo texto antigo, exige
-- exatamente 1 ocorrência e confere, no fim, que o md5(prosrc) das quatro
-- funções voltou ao de produção em 12/11/2026. Divergiu, ABORTA.
-- (Não usa internal.patch_funcao_ancorada: ele recusa patch que APAGA texto.)
--
-- ZERO DML. Nenhum agendamento tocado.

BEGIN;

DO $rb$
DECLARE
  r record;
  v_src text;
  v_n int;
  v_md5 text;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      (1, 'liberar_fidelizacao_caso',
$novo$  -- Portao interno (12/11/2026): so o cron (sem JWT) e a gestao soltam caso.
  if auth.jwt() is not null and not public.usuario_e_gestao_fila() then
    raise exception 'sem_permissao' using errcode='42501';
  end if;
  select * into v_c from public.casos where id = p_caso_id for update;$novo$,
$antigo$  select * into v_c from public.casos where id = p_caso_id for update;$antigo$),
      (2, 'liberar_fidelizacao_caso',
$novo$  if public.caso_em_giro_fidelizacao(v_c.giro_fidelizacao_ate) then
    -- Caso de giro: exclusivo ate a DATA da fidelizacao do lote. Vencida a
    -- data, a marca historica nao segura mais nada -- vale a regra comum dos
    -- 10 dias do ultimo acionamento, logo abaixo (regra da gestao, 12/11/2026).
    return false;$novo$,
$antigo$  if v_c.giro_fidelizacao_ate is not null then
    -- Caso de giro: nao volta ao pool por rotina automatica. Ate a data da
    -- fidelizacao por exclusividade; depois dela, para preservar o responsavel
    -- ate que outro operador assuma pelo fluxo normal.
    return false;$antigo$),
      (5, 'liberar_fidelizacao_caso',
$novo$  if public.caso_dentro_prazo_fidelizacao(v_c.data_ultimo_acionamento) then return false; end if;
  if v_c.aluno_id is not null and exists (
       select 1 from public.alunos a
        where a.id = v_c.aluno_id
          and a.data_retorno >= (now() at time zone 'America/Sao_Paulo')::date
          and upper(coalesce(a.retorno_origem,'')) like 'OPERADOR%') then
    return false;  -- retorno marcado pelo operador: compromisso preservado
  end if;
  -- Soltar este caso solta, por gatilho, TODOS os casos do mesmo aluno. Trava
  -- as linhas de todos eles ANTES de ler os irmaos: sem isso, um acionamento
  -- concorrente pode mudar a resposta depois da leitura. Ordem por id = sem impasse.
  if v_c.aluno_id is not null then
    perform 1 from public.casos o where o.aluno_id = v_c.aluno_id order by o.id for update;
  end if;
  if not public.caso_pode_soltar_com_aluno(p_caso_id) then
    return false;  -- irmao que nao pode sair segura o aluno inteiro
  end if;$novo$,
$antigo$  if public.caso_dentro_prazo_fidelizacao(v_c.data_ultimo_acionamento) then return false; end if;$antigo$),
      (6, 'casos_risco_perder',
$novo$    and not public.caso_dentro_prazo_fidelizacao(c.data_ultimo_acionamento)
    -- giro: exclusivo so ate a DATA do lote (12/11/2026)
    and not public.caso_em_giro_fidelizacao(c.giro_fidelizacao_ate)
    -- retorno agendado pelo operador (hoje ou futuro) e compromisso, nao risco
    and not exists (select 1 from public.alunos a
                     where a.id = c.aluno_id
                       and a.data_retorno >= (now() at time zone 'America/Sao_Paulo')::date
                       and upper(coalesce(a.retorno_origem,'')) like 'OPERADOR%')$novo$,
$antigo$    and not public.caso_dentro_prazo_fidelizacao(c.data_ultimo_acionamento)$antigo$),
      (8, 'trg_impor_teto_operador',
$novo$
      AND public.caso_pode_soltar_com_aluno(c.id)$novo$,
$antigo$$antigo$),
      (9, 'assumir_caso_livre',
$novo$      and not public.caso_encerrado_operacional(c.cpf_limpo,c.status_atual,c.status_acionamento,c.status_financeiro,c.status_jornada)
      and public.caso_pode_soltar_com_aluno(c.id)   -- A1 (12/11/2026): trocar este caso tambem solta os irmaos
    order by abs(public.saldo_titulos_aberto(c.cpf_limpo) - v_new_saldo) asc$novo$,
$antigo$      and not public.caso_encerrado_operacional(c.cpf_limpo,c.status_atual,c.status_acionamento,c.status_financeiro,c.status_jornada)
    order by abs(public.saldo_titulos_aberto(c.cpf_limpo) - v_new_saldo) asc$antigo$),
      (3, 'trg_impor_teto_operador',
$novo$AND NOT public.caso_em_giro_fidelizacao(c.giro_fidelizacao_ate)$novo$,
$antigo$AND c.giro_fidelizacao_ate IS NULL$antigo$),
      (4, 'assumir_caso_livre',
$novo$    if v_pool is null and (v_new.giro_fidelizacao_ate is null
         or public.caso_dentro_prazo_fidelizacao(v_new.data_ultimo_acionamento)) then$novo$,
$antigo$    if v_pool is null and v_new.giro_fidelizacao_ate is null then$antigo$)
    ) AS t(ordem, funcao, novo, antigo)
    ORDER BY ordem
  LOOP
    SELECT pg_get_functiondef(p.oid) INTO v_src
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = r.funcao;
    IF v_src IS NULL THEN
      RAISE EXCEPTION 'rollback fidelizacao_giro: public.% nao existe.', r.funcao;
    END IF;
    v_n := (length(v_src) - length(replace(v_src, r.novo, ''))) / length(r.novo);
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'rollback fidelizacao_giro: public.% tem % ocorrencia(s) do trecho % (esperado 1). A funcao mudou; revise.',
        r.funcao, v_n, r.ordem;
    END IF;
    EXECUTE replace(v_src, r.novo, r.antigo);
  END LOOP;

  FOR r IN
    SELECT * FROM (VALUES
      ('liberar_fidelizacao_caso', 'de8a3b43392c010c080adfcd9bd2560a'),
      ('trg_impor_teto_operador',  '3d01bbd194b76dc8455e9dd47d395cca'),
      ('assumir_caso_livre',       '607a8b4fb8a0aba2f0ecda830b1c6e2c'),
      ('casos_risco_perder',       '702279a5830bdbe566bc7140563bc3ed')
    ) AS t(funcao, md5_prod)
  LOOP
    SELECT md5(p.prosrc) INTO v_md5
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = r.funcao;
    IF v_md5 IS DISTINCT FROM r.md5_prod THEN
      RAISE EXCEPTION 'rollback fidelizacao_giro: public.% ficou com md5 %, esperado % (producao em 12/11/2026).',
        r.funcao, v_md5, r.md5_prod;
    END IF;
  END LOOP;
END
$rb$;

-- Regra unica de irmaos: some depois dos patches (o teto e a liberacao ja nao a chamam).
DROP FUNCTION IF EXISTS public.caso_pode_soltar_com_aluno(uuid);

COMMIT;
