-- ---------------------------------------------------------------------------
-- PROPOSTA -- NAO APLICADA EM PRODUCAO
--
-- Portao de gestao em public.carteira_geral_vigia().
--
-- POR QUE
-- Medido em producao em 26/09/2026:
--   prosecdef = true
--   acl       = postgres=X | authenticated=X | service_role=X
--   portao calibragem_e_gestao() no corpo: NAO
--   has_function_privilege('authenticated', 'public.carteira_geral_vigia()', 'EXECUTE') -> true
--
-- Ou seja: qualquer pessoa logada -- inclusive operador comum -- le hoje quantos
-- casos e acordos estao na Carteira Geral, quantas saidas ocorreram sem
-- auditoria e, o que mais pesa, a lista `operadores_sem_entrada_de_casos`: os
-- NOMES de quem esta inativo ou com a entrada de casos novos fechada pela
-- gestao. Isso e informacao de pessoal, e responde "quem a gestao desligou"
-- para qualquer colega que saiba chamar a funcao.
--
-- As outras seis funcoes do pacote (painel, listar, previa, mover,
-- desfazer_lote, definir_recebimento) ja tem esse portao. O vigia ficou sem.
--
-- O QUE MUDA E O QUE NAO MUDA
-- Muda: `language sql` vira `language plpgsql`, so para caber o portao.
-- NAO muda: o miolo do jsonb_build_object e identico, sem uma virgula
-- diferente; a assinatura, o tipo de retorno, STABLE, SECURITY DEFINER e o
-- search_path continuam os mesmos.
--
-- O GRANT PARA `authenticated` FICA.
-- Restringir a gestao e portao INTERNO, nunca `revoke` de `authenticated` --
-- foi exatamente assim que uma tela caiu para a propria gestao em 12/09/2026.
--
-- EFEITO COLATERAL QUE PRECISA IR JUNTO PARA O ROTEIRO
-- Depois desta trava, chamar o vigia pelo SQL Editor SEM claim de gestao passa a
-- dar 42501. Os pontos afetados estao listados na secao "Proposta, NAO aplicada"
-- de docs/PREFLIGHT-CARTEIRA-GERAL-2026-09-25.md. Todos precisam abrir com
--   begin;
--   set local request.jwt.claims = '{"email":"amanda.seibel@aelbra.com.br","role":"authenticated"}';
--   ...
--   rollback;
--
-- E UM ALERTA PARA O FUTURO: se um dia o vigia entrar em invariantes_rodar()
-- (o job diario das 09:10, que roda SEM JWT), ele NAO pode chamar esta funcao
-- publica -- daria 42501 e derrubaria a rodada. Nesse dia, o job chama uma
-- versao interna sem portao, e a publica continua sendo a da tela.
--
-- O QUE ESTA TRAVA NAO RESOLVE, e nao adianta fingir que resolve:
-- ela protege a RPC, nao o dado. `usuarios` e lida amplamente pelo app, entao um
-- operador determinado provavelmente reproduz `operadores_sem_entrada_de_casos`
-- por consulta direta. Fechar isso e outra frente (RLS em usuarios), maior e
-- com risco proprio.
-- ---------------------------------------------------------------------------

-- PRECONDICAO: recusa aplicar se o corpo vivo nao for um dos DOIS que esta
-- proposta conhece -- o de hoje, ou o que ela mesma instala.
--
-- Nao basta procurar a palavra 'calibragem_e_gestao' no corpo: um corpo de
-- terceiro que apenas mencione o nome (ate num comentario) passaria, e o
-- `create or replace` abaixo o sobrescreveria em silencio. So md5 exato serve.
do $precondicao$
declare
  v_md5 text;
  v_oid oid;
  c_hoje  constant text := 'c3ed8f59a439440536677ba3660e12f4';  -- 1.240 chars, medido em producao 26/09/2026
  c_novo  constant text := 'ed04170d2f95876ed2dcf4ae15c6d770';  -- 1.533 chars, o corpo instalado por este arquivo
begin
  -- Por regprocedure, nao por nome: assinatura errada nao passa despercebida.
  begin
    v_oid := 'public.carteira_geral_vigia()'::regprocedure;
  exception when undefined_function then
    raise exception 'public.carteira_geral_vigia() nao existe -- aplique 20260925181823 antes desta.';
  end;

  select md5(p.prosrc) into v_md5 from pg_proc p where p.oid = v_oid;

  if v_md5 = c_novo then
    raise notice 'trava ja aplicada: o corpo vivo e exatamente o desta proposta. O create or replace abaixo e inofensivo.';
    return;
  end if;

  if v_md5 <> c_hoje then
    raise exception
      'o corpo de carteira_geral_vigia() nao e nenhum dos dois que esta proposta conhece (md5 vivo %, esperado % antes ou % depois). Leia a funcao viva e refaca esta proposta: aplicar as cegas sobrescreveria a mudanca de outra pessoa.',
      v_md5, c_hoje, c_novo;
  end if;
end
$precondicao$;

create or replace function public.carteira_geral_vigia()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'internal'
as $fn$
begin
  -- O portao e o `return (` sao o que muda. O jsonb_build_object abaixo e o
  -- corpo de 20260925181823, intacto.
  if not public.calibragem_e_gestao() then
    raise exception 'Sem permissao para ver o vigia da Carteira Geral.' using errcode = '42501';
  end if;

  return (
  select jsonb_build_object(
    'na_carteira_geral', (select count(*) from public.casos
                           where lower(coalesce(operador_email,'')) = internal.carteira_geral_email()),
    'acordos_na_carteira_geral', (select count(*) from public.acordos
                                   where lower(coalesce(operador_responsavel_email,'')) = internal.carteira_geral_email()),
    'operadores_sem_entrada_de_casos', (select coalesce(jsonb_agg(nome order by nome), '[]'::jsonb)
                                      from public.usuarios
                                     where perfil = 'operador'
                                       and (not ativo or not coalesce(recebe_novos_casos, true))),
    -- casos que sairam da Carteira Geral sem passar por carteira_geral_mover:
    -- a auditoria registra toda saida legitima.
    'saidas_sem_auditoria', (
      select count(*) from public.historico_operadores_alunos h
       where h.operador_anterior_email = internal.carteira_geral_email()
         and not exists (select 1 from public.carteira_geral_auditoria a
                          where a.aluno_id = h.aluno_id and a.registrado_em between h.criado_em - interval '1 minute' and h.criado_em + interval '1 minute'))
  )
  );
end;
$fn$;

comment on function public.carteira_geral_vigia() is
  'Vigia da Carteira Geral. Portao de gestao (calibragem_e_gestao) porque a saida traz os NOMES dos operadores que a gestao desligou. Grant para authenticated mantido de proposito: portao interno, nunca revoke.';

revoke all on function public.carteira_geral_vigia() from public, anon;
grant execute on function public.carteira_geral_vigia() to authenticated;
