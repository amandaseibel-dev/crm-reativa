-- Volta ao texto de 20260922220000 (que usava alunos.matricula, incorreto). Nao recomendado; existe so
-- para simetria do processo de rollback.
create or replace function public.prime_extrato_reenfileirar_pendentes_vinculo()
 returns integer language plpgsql security definer set search_path to 'public'
as $function$
declare v_n integer;
begin
  insert into public.prime_extrato_fila (matricula, cpf, motivo, tentativas, criado_em)
  select distinct al.matricula, al.cpf, 'pendente_vinculo_diario', 0, now()
    from public.acordos a
    join public.alunos al on al.id = a.aluno_id
   where upper(coalesce(a.status, '')) in ('ATIVO', 'QUITADO')
     and al.matricula is not null and al.matricula <> ''
     and not exists (
       select 1 from public.acordo_titulo_vinculo v
         join public.acordos_titulos t on t.id = v.titulo_id and coalesce(t.tipo_boleto, '') <> 'Acordo'
        where v.acordo_id = a.id and coalesce(v.ativo, true)
     )
     and exists (
       select 1 from public.acordos_titulos t2
        where t2.aluno_id = a.aluno_id and coalesce(t2.tipo_boleto, '') <> 'Acordo'
          and upper(coalesce(t2.situacao, '')) in ('ABERTO', 'EM_CONFIRMACAO')
          and t2.acordo_id is null
          and not exists (select 1 from public.acordo_titulo_vinculo v2 where v2.titulo_id = t2.id and coalesce(v2.ativo, true))
     )
  on conflict (matricula) do update
     set coletado_em = null, tentativas = 0, ultimo_erro = null, motivo = excluded.motivo, criado_em = excluded.criado_em;
  get diagnostics v_n = row_count;
  return v_n;
end;
$function$;
