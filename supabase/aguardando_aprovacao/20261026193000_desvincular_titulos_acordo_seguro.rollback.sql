-- ROLLBACK -- devolve `desvincular_titulos_acordo` ao corpo de PRODUÇÃO
-- =============================================================================
-- Corpo medido em produção em 26/10/2026: md5(prosrc) =
-- `ebd07b0ec54e64f9ab685928988cb9a5`. O teste
-- `supabase/tests/desvincular_titulos_acordo_seguro.test.js` confere esse md5
-- depois de aplicar este arquivo -- byte a byte, não "parecido".
--
-- ATENÇÃO: voltar para este corpo devolve os três defeitos documentados na
-- migration (sem portão, reabre mensalidade paga, apaga a cadeia do vínculo).
-- =============================================================================

create or replace function public.desvincular_titulos_acordo(p_titulo_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_email text := lower(coalesce(auth.email(),''));
  v_n int;
begin
  if v_email = '' then return jsonb_build_object('ok',false,'erro','NAO_AUTENTICADO'); end if;

  -- Volta a mensalidade para ABERTO (conta de novo no total do aluno).
  -- ANTES gravava status='vinculada' aqui, produzindo a combinacao incoerente
  -- (ABERTO + vinculada + sem vinculo) que dobrava a divida e travava a tela.
  update public.acordos_titulos
     set acordo_id = null, situacao = 'ABERTO', status = 'em_aberto',
         vinculado_em = null, vinculado_por = null, atualizado_em = now()
   where id = any(p_titulo_ids);
  get diagnostics v_n = row_count;

  delete from public.acordo_titulo_vinculo where titulo_id = any(p_titulo_ids);

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values (v_email, 'DESVINCULOU_TITULOS_ACORDO', 'acordos_titulos', null,
          jsonb_build_object('qtd', v_n, 'titulo_ids', p_titulo_ids));

  return jsonb_build_object('ok', true, 'desvinculados', v_n);
end;
$fn$;
