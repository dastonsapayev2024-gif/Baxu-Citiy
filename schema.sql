-- Server jadvalni o'zi yaratadi (qo'lda bajarish shart emas).
create table if not exists docs(
  col text not null,
  id text not null,
  data jsonb not null,
  updated bigint not null,
  primary key(col,id)
);
create index if not exists docs_col_upd on docs(col,updated);
