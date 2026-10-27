-- =============================================================================
-- ROLLBACK de 20261027170000_revoke_authenticated_auxiliares_encerramento
--
-- DEVOLVE O ORACULO INTERNO. Reabre a possibilidade de qualquer usuario
-- AUTENTICADO -- inclusive operador sem perfil de gestao -- sondar CPF a CPF
-- pelas tres auxiliares, e consultar congelamento pela quarta.
--
-- So se justifica se a restricao quebrar consumidor nao previsto. Em
-- 27/10/2026 o censo em producao mediu ZERO: as quatro sao chamadas apenas por
-- funcoes `security definer` do `postgres`, sem views, sem gatilhos e sem
-- chamadores com direitos do invocador; e o app nao as chama.
--
-- NAO E RESTORE: o PITR nao esta habilitado neste projeto. E SQL por
-- identidade, aplicado para frente.
-- =============================================================================
--
-- BASEADO NO PRIVILEGIO EFETIVAMENTE EXISTENTE ANTES, nao em suposicao.
-- Medido em producao em 27/10/2026, nas quatro:
--   `has_function_privilege('authenticated', <sig>, 'EXECUTE')` = true
-- Logo devolver `authenticated` restaura o estado anterior, e nada alem dele.
--
-- O QUE ESTE ARQUIVO NAO FAZ, de proposito:
--   * NAO concede a PUBLIC. PUBLIC foi revogado por 20261027160000, que tem o
--     rollback proprio. Conceder aqui ampliaria acesso muito alem do que esta
--     migration tirou -- e reabriria o oraculo ANONIMO, que e o P0 contido em
--     27/10/2026 as 15:25 UTC.
--   * NAO concede a `anon`. `anon` nunca teve concessao direta em nenhuma das
--     quatro; o acesso dele vinha de PUBLIC.
--   * NAO toca `service_role`, que esta migration preservou.
--   * NAO toca as duas assinaturas publicas de `caso_encerrado_operacional`,
--     que esta migration nunca restringiu.
--
-- DEPENDENCIA: o papel `authenticated` precisa existir, senao 42704. E o
-- executor precisa ser dono ou ter grant option -- um `grant` sem direito
-- emite WARNING "no privileges could be granted" e NAO concede nada. O bloco
-- de conferencia do fim e o que pega essa falha silenciosa.
-- -----------------------------------------------------------------------------

grant execute on function public._caso_sem_saldo_conferido(uuid, text)
  to authenticated;
grant execute on function public._caso_encerrado_operacional_regra(uuid, uuid, text, text, text, text, text)
  to authenticated;
grant execute on function public._encerramento_congelado(uuid, uuid, text, text, text, text, text)
  to authenticated;
grant execute on function public.caso_encerramento_congelado(uuid)
  to authenticated;

-- -----------------------------------------------------------------------------
-- CONFERENCIA, NOS DOIS SENTIDOS
--
-- Por PRIVILEGIO EFETIVO, nunca por texto de `proacl`: a ordem do array e o
-- concedente nao sao estaveis, e `proacl` NULO e o estado PADRAO, que para
-- funcao INCLUI EXECUTE a PUBLIC.
-- -----------------------------------------------------------------------------

do $confere$
declare
  v_faltou  text;
  v_vazou   text;
begin
  -- (1) as quatro precisam ter voltado para `authenticated`
  select string_agg(a.sig, ', ' order by a.sig) into v_faltou
    from (values
      ('public._caso_sem_saldo_conferido(uuid,text)'),
      ('public._caso_encerrado_operacional_regra(uuid,uuid,text,text,text,text,text)'),
      ('public._encerramento_congelado(uuid,uuid,text,text,text,text,text)'),
      ('public.caso_encerramento_congelado(uuid)')
    ) as a(sig)
   where to_regprocedure(a.sig) is null
      or not has_function_privilege('authenticated', to_regprocedure(a.sig), 'EXECUTE');

  if v_faltou is not null then
    raise exception
      'ROLLBACK_INCOMPLETO: `authenticated` segue sem EXECUTE em %. Verifique se o executor e dono ou tem grant option -- `grant` sem direito emite WARNING e nao concede.',
      v_faltou;
  end if;

  -- (2) e PUBLIC/anon NAO podem ter voltado -- isso seria reabrir o P0
  select string_agg(a.sig, ', ' order by a.sig) into v_vazou
    from (values
      ('public._caso_sem_saldo_conferido(uuid,text)'),
      ('public._caso_encerrado_operacional_regra(uuid,uuid,text,text,text,text,text)'),
      ('public._encerramento_congelado(uuid,uuid,text,text,text,text,text)'),
      ('public.caso_encerramento_congelado(uuid)')
    ) as a(sig)
   where has_function_privilege('public', to_regprocedure(a.sig), 'EXECUTE')
      or has_function_privilege('anon',   to_regprocedure(a.sig), 'EXECUTE');

  if v_vazou is not null then
    raise exception
      'P0_REABERTO: PUBLIC ou anon voltaram a executar %. Este rollback NAO deveria ter feito isso -- investigue antes de seguir.',
      v_vazou;
  end if;
end
$confere$;
