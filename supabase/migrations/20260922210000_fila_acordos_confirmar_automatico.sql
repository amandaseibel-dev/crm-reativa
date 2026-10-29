-- CONFIRMACAO AUTOMATICA DOS ACORDOS IMPORTADOS QUE O CRM JA CONHECE.
-- fila_acordos_confirmar.status_confirmacao='A_CONFIRMAR' espera um clique humano que hoje so REPETE o que
-- o sistema ja sabe: em ~85% dos casos o acordo correspondente ja existe, ja esta ATIVO e bate exatamente
-- em quantidade de parcelas e valor total. Este job confirma so esses -- sem clique -- e deixa tudo o mais
-- (acordo ausente/nao-ativo, mais de um ATIVO com a mesma base, ou divergencia de qtd/valor) exatamente
-- como esta hoje, para a tela e para a gestao decidirem.
--
-- CHAVE DETERMINISTICA: `acordo_base` (10 digitos) = '05' || numero_ulbra com 6 digitos || '00'. Validada em
-- producao: nao usa aluno_id sozinho (um aluno pode ter varios acordos ATIVO -- juntar so por aluno_id da
-- casamento errado, ja visto na medicao). Nao usa valor do acordo para decidir vinculo de mensalidade --
-- valor e qtd_parcelas aqui so confirmam a IDENTIDADE do proprio acordo, exigidos junto com a chave, nunca
-- sozinhos.
begin;

create or replace function public.fila_acordos_confirmar_automatico(p_limite int default 500)
 returns jsonb language plpgsql security definer set search_path to 'public' set statement_timeout to '60s'
as $function$
declare
  c record;
  v_ator constant text := 'confirmacao-automatica@sistema';
  v_ok int := 0; v_pulados int := 0; v_falhas int := 0;
begin
  if not pg_try_advisory_xact_lock(hashtext('fila_acordos_confirmar_automatico')) then
    return jsonb_build_object('ok', true, 'pulou', 'EM_EXECUCAO');
  end if;
  if coalesce((public.sistema_sob_carga() ->> 'sob_carga')::boolean, false) then
    return jsonb_build_object('ok', true, 'pulou', 'SOB_CARGA');
  end if;

  for c in
    select f.id
      from public.fila_acordos_confirmar f
     where f.status_confirmacao = 'A_CONFIRMAR'
     order by f.id
     limit greatest(coalesce(p_limite, 500), 1)
  loop
    begin
      -- reavaliacao fresca: exatamente 1 acordo ATIVO com a mesma chave, e qtd_parcelas/valor_total batendo
      if (
        select count(*) filter (where a.status = 'ATIVO') = 1
           and bool_and(a.qtd_parcelas is not distinct from f.qtd_parcelas
                         and a.valor_total is not distinct from f.valor_total) filter (where a.status = 'ATIVO')
          from public.fila_acordos_confirmar f
          join public.acordos a on '05' || lpad(a.numero_ulbra, 6, '0') || '00' = f.acordo_base
         where f.id = c.id
      ) then
        update public.fila_acordos_confirmar
           set status_confirmacao = 'CONFIRMADO', operador_email = v_ator, confirmado_em = now()
         where id = c.id and status_confirmacao = 'A_CONFIRMAR';
        if found then
          v_ok := v_ok + 1;
          insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
          values (v_ator, 'FILA_ACORDO_CONFIRMADO_AUTOMATICO', 'fila_acordos_confirmar', c.id,
                  jsonb_build_object('motivo', 'acordo ATIVO unico por acordo_base, qtd_parcelas e valor_total batendo'));
        else
          v_pulados := v_pulados + 1;
        end if;
      else
        v_pulados := v_pulados + 1;
      end if;
    exception when others then
      v_falhas := v_falhas + 1;
    end;
  end loop;

  return jsonb_build_object('ok', true, 'confirmados', v_ok, 'pulados', v_pulados, 'falhas', v_falhas);
end;
$function$;

revoke all on function public.fila_acordos_confirmar_automatico(int) from public, anon, authenticated;
grant execute on function public.fila_acordos_confirmar_automatico(int) to service_role;

-- job a cada 20 min, fora do :40 (rodada horaria de pagamentos, nao tocada)
select cron.schedule('fila_acordos_confirmar_automatico', '5,25,45 * * * *',
  $cron$select public.fila_acordos_confirmar_automatico(500);$cron$);

commit;
