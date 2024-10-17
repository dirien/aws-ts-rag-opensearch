FROM public.ecr.aws/docker/library/python:3.12-bullseye
ARG CLOUD_PROVIDER

WORKDIR /app

COPY . .

RUN pip install ".[${CLOUD_PROVIDER}]"

EXPOSE 8501

ENTRYPOINT ["streamlit", "run", "streamlit_app/main.py"]
