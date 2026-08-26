-- Rollback: o card "Entrou" volta a somar parcelas.honorarios.
--
-- ATENÇÃO: isso devolve o erro de duas ordens de grandeza. Só 7,8% das parcelas
-- pagas têm honorário preenchido -- a tela mostrava R$ 5 mil onde tinham
-- entrado R$ 837 mil, e discordava da Projeção.
create or replace function public.honorarios_a_entrar(p_email text default null)
returns table(
  parcela_id uuid, acordo_id uuid, aluno_id uuid, aluno_nome text,
  operador_email text, numero integer, vencimento date, valor numeric,
  honorario numeric, estado text, acordo_total numeric, is_entrada boolean
)
language plpgsql stable security definer set search_path to 'public'
as $function$
declare
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_gestao boolean := false;
  v_alvo text;
begin
  begin v_gestao := coalesce(public.usuario_e_gestao(), false);
  exception when others then v_gestao := false; end;
  v_alvo := case when v_gestao then nullif(lower(coalesce(p_email,'')), '') else nullif(v_email, '') end;
  return query
  select p.id, a.id, a.aluno_id, coalesce(al.nome, '-'),
    lower(coalesce(nullif(a.operador_responsavel_email,''), al.responsavel_atual_email, '')),
    p.numero, p.vencimento, round(coalesce(p.valor,0), 2), round(coalesce(p.honorarios,0), 2),
    case when p.status = 'PAGO' then 'PAGO'
         when p.vencimento < current_date then 'VENCIDO' else 'A_VENCER' end,
    round(coalesce(a.valor_total,0), 2), coalesce(p.is_entrada, false)
  from public.parcelas p
  join public.acordos a on a.id = p.acordo_id
  left join public.alunos al on al.id = a.aluno_id
  where a.status = 'ATIVO' and coalesce(p.status,'') <> 'CANCELADA'
    and (v_alvo is null or lower(coalesce(nullif(a.operador_responsavel_email,''), al.responsavel_atual_email, '')) = v_alvo)
  order by p.vencimento, al.nome;
end;
$function$;
