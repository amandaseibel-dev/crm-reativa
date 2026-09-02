-- PADRÃO: o e-mail é a chave, o nome vem do cadastro de usuários.
--
-- O PROBLEMA. `pagamentos.operador_nome` entrava como viesse da planilha, sem
-- padronização. Medido em 02/09/2026: 7.017 linhas divergindo do cadastro,
-- 52 variantes, R$ 9.994.276,67. A Olga aparecia como OLGA, OLGA.OLIVEIRA
-- (R$ 89.914,57), Olga, "Olga " e olga; o Diego como DIEGO, "DIEGO "
-- (R$ 59.271,94), DIEGO.CRUZ e diego; a Luana em seis grafias.
--
-- NÃO QUEBRAVA A PROJEÇÃO, e por isso passou despercebido: ela agrupa por
-- e-mail, então os números sempre fecharam. Quebra qualquer relatório que
-- agrupe por NOME -- ali a Olga vira cinco pessoas.
--
-- O CASO QUE TROUXE ISSO À TONA: a Nataly (cobranca08) estava gravada como
-- "NATALI". Não era erro de digitação da planilha -- era o código: o mapa em
-- src/utils/operadores.js tinha `cobranca08: "NATALI"` E um alias
-- `NATALY -> NATALI` que convertia a grafia certa na errada. O cadastro de
-- usuários sempre disse "Nataly". Corrigido junto, com o alias invertido para
-- planilha antiga com "NATALI" continuar casando com a operadora certa.
--
-- A DECISÃO: existe UMA fonte para o nome, e é `usuarios.nome`. É o cadastro que
-- a gestão já mantém -- renomear lá passa a valer em todo lugar. O mapa do
-- frontend continua existindo para o caminho inverso (descobrir o e-mail a
-- partir do nome que vem na planilha), que é outra função.
--
-- Linhas sem `operador_email` ficam INTOCADAS de propósito: são 22 pessoas das
-- unidades (STEPHANIE.PAULA, ADEMIR.SANTOS, ...), R$ 278.141,56 em agosto, que
-- não têm cadastro no CRM. O nome cru delas é o único vínculo com o arquivo de
-- origem, e elas entram no total da filial sem card individual -- mesmo caso da
-- Fernanda (supervisora) e da própria Amanda quando fecha acordo sem dono.
create table if not exists _backup_operador_nome_20260902 (
  pagamento_id uuid, operador_email text, nome_antigo text, nome_novo text,
  feito_em timestamptz default now()
);
alter table _backup_operador_nome_20260902 enable row level security;

insert into _backup_operador_nome_20260902 (pagamento_id, operador_email, nome_antigo, nome_novo)
select p.id, p.operador_email, p.operador_nome, u.nome
from pagamentos p join usuarios u on u.email = p.operador_email
where p.operador_nome is distinct from u.nome;

update pagamentos p
   set operador_nome = u.nome
  from usuarios u
 where u.email = p.operador_email
   and p.operador_nome is distinct from u.nome;

-- A trava. Sem ela a próxima importação traz a bagunça de volta -- e o defeito
-- vinha justamente de uma tabela fixa no frontend, que ninguém lembra de mexer.
create or replace function public.tg_pagamento_nome_do_operador()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.operador_email is not null then
    select u.nome into new.operador_nome
      from public.usuarios u
     where u.email = new.operador_email;
    -- e-mail que não está no cadastro: mantém o que veio, para não apagar
    -- informação que pode ser o único rastro de quem recebeu.
    if new.operador_nome is null then
      new.operador_nome := coalesce(old.operador_nome, new.operador_nome);
    end if;
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_pagamento_nome_do_operador on public.pagamentos;
create trigger trg_pagamento_nome_do_operador
  before insert or update of operador_email, operador_nome on public.pagamentos
  for each row execute function public.tg_pagamento_nome_do_operador();
